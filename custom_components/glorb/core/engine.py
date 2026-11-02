"""Renders effects and turns them into DDP frames. Knows nothing of Home Assistant."""
from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import logging
import math
import time
from typing import Any, Callable

import numpy as np

from . import palettes
from .effects import REGISTRY, Audio, Ctx, Effect
from .geometry import CELLS, LED_COUNT, Geometry, build

_LOGGER = logging.getLogger(__name__)

DDP_HEADER = bytes([0x41, 0x00, 0x01, 0x01, 0, 0, 0, 0]) + (CELLS * 3).to_bytes(2, "big")


@dataclass
class Globals:
    """Applied on top of every effect."""

    spin: float = 0.0  # turns per minute
    tumble: float = 0.0  # tilts the axis of spin
    hue: float = 0.0  # degrees
    saturation: float = 1.0
    gain: float = 1.0
    gamma: float = 2.8  # the firmware's own value. Live frames skip its correction.
    transition: float = 1.0  # seconds


@dataclass
class Overlay:
    """A timed layer over the current effect, for alerts."""

    pattern: str
    color: np.ndarray
    color2: np.ndarray
    started: float
    duration: float
    origin: np.ndarray
    opacity: float = 1.0


OVERLAY_PATTERNS = ("pulse", "flash", "ring", "sweep", "split", "spin")


def _hue_rotate(rgb: np.ndarray, degrees: float, saturation: float) -> np.ndarray:
    grey = (rgb @ np.array([0.299, 0.587, 0.114]))[:, None]
    out = grey + (rgb - grey) * saturation
    if degrees:
        a = math.radians(degrees)
        c, s = math.cos(a), math.sin(a)
        one = 1 / 3
        root = math.sqrt(one)
        m = np.array(
            [
                [c + (1 - c) * one, one * (1 - c) - root * s, one * (1 - c) + root * s],
                [one * (1 - c) + root * s, c + one * (1 - c), one * (1 - c) - root * s],
                [one * (1 - c) - root * s, one * (1 - c) + root * s, c + one * (1 - c)],
            ]
        )
        out = out @ m.T
    return np.clip(out, 0, 1)


class Engine:
    def __init__(
        self,
        send: Callable[[bytes], None],
        *,
        geometry: Geometry | None = None,
        fps: int = 40,
        state_of: Callable[[str], tuple[str, dict[str, Any]] | None] | None = None,
    ) -> None:
        self.send = send
        self.geo = geometry or build()
        self.fps = fps
        self.state_of = state_of or (lambda _entity: None)
        self.globals = Globals()
        self.audio = Audio()
        self.rng = np.random.default_rng()
        self.current: Effect | None = None
        self.previous: Effect | None = None
        self.fade_left = 0.0
        self.fade_total = 1.0
        self.overlays: list[Overlay] = []
        self.on_frame: Callable[[bytes], None] | None = None
        self.running = False
        self.clock = 0.0
        self.spin_angle = 0.0
        self.tumble_angle = 0.0
        self.render_ms = 0.0
        self.actual_fps = 0.0
        self._task: asyncio.Task | None = None
        self._error = np.zeros((LED_COUNT, 3))
        self._packet = bytearray(DDP_HEADER + bytes(CELLS * 3))

    # Control

    def play(self, effect_id: str, params: dict[str, Any] | None = None, *, transition: float | None = None) -> Effect:
        if effect_id not in REGISTRY:
            raise KeyError(effect_id)
        fx = REGISTRY[effect_id](self.geo, self.rng)
        if params:
            fx.set(params)
        if self.current is not None:
            self.previous = self.current
            self.fade_total = self.fade_left = max(0.0, self.globals.transition if transition is None else transition)
            if self.fade_total == 0:
                self.previous = None
        self.current = fx
        return fx

    def set_params(self, values: dict[str, Any]) -> None:
        if self.current:
            self.current.set(values)

    def set_geometry(self, geometry: Geometry) -> None:
        self.geo = geometry
        if self.current:
            self.current.geo = geometry
        if self.previous:
            self.previous.geo = geometry

    def set_globals(self, values: dict[str, Any]) -> None:
        for key, value in values.items():
            if hasattr(self.globals, key):
                setattr(self.globals, key, float(value))

    def alert(
        self,
        pattern: str = "pulse",
        color: str = "#ff0000",
        color2: str = "#000000",
        duration: float = 3.0,
        opacity: float = 1.0,
    ) -> None:
        self.overlays.append(
            Overlay(
                pattern if pattern in OVERLAY_PATTERNS else "pulse",
                palettes.color(color),
                palettes.color(color2),
                self.clock,
                max(0.1, duration),
                self.rng.normal(size=3),
                max(0.0, min(1.0, opacity)),
            )
        )

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "effect": self.current.id if self.current else None,
            "params": dict(self.current.p) if self.current else {},
            "globals": asdict(self.globals),
            "fps": round(self.actual_fps, 1),
            "render_ms": round(self.render_ms, 2),
            "audio_active": self.audio.active,
        }

    # Rendering

    def _make_ctx(self, dt: float) -> Ctx:
        g = self.globals
        self.spin_angle += dt * g.spin * 2 * math.pi / 60
        self.tumble_angle += dt * g.tumble * 2 * math.pi / 60
        pos = self.geo.pos
        lat, lon = self.geo.lat, self.geo.lon
        if self.spin_angle or self.tumble_angle:
            cz, sz = math.cos(self.spin_angle), math.sin(self.spin_angle)
            cx, sx = math.cos(self.tumble_angle), math.sin(self.tumble_angle)
            rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
            rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
            pos = pos @ (rz @ rx)
            lat = np.arcsin(np.clip(pos[:, 2], -1, 1))
            lon = np.arctan2(pos[:, 1], pos[:, 0])
        return Ctx(pos, lat, lon, self.clock, dt, self.audio, self.state_of, datetime.now(timezone.utc))

    def _apply_overlays(self, rgb: np.ndarray) -> np.ndarray:
        live = []
        pos = self.geo.pos
        for o in self.overlays:
            k = (self.clock - o.started) / o.duration
            if k >= 1:
                continue
            live.append(o)
            age = self.clock - o.started
            envelope = min(1.0, min(age, o.duration - age) * 8)
            if o.pattern == "flash":
                mask = np.full(LED_COUNT, 1.0 if int(age * 6) % 2 == 0 else 0.0)
            elif o.pattern == "ring":
                origin = o.origin / np.linalg.norm(o.origin)
                angle = np.arccos(np.clip(pos @ origin, -1, 1))
                mask = np.exp(-(((angle - (age * 2.4) % math.pi) / 0.4) ** 2))
            elif o.pattern == "sweep":
                mask = np.exp(-(((pos[:, 2] - math.sin(age * 3)) / 0.4) ** 2))
            elif o.pattern == "split":
                mask = (pos[:, 2] > math.sin(age * 2.0) * 0.3).astype(float)
            elif o.pattern == "spin":
                mask = np.maximum(0.0, np.cos(self.geo.lon * 2 + age * 6)) ** 2
            else:
                mask = np.full(LED_COUNT, 0.5 + 0.5 * math.sin(age * 6 - 1.5))
            mask = mask[:, None]
            strength = envelope * o.opacity
            if o.color2.any():
                # Two colors replace the effect outright, one color lets it show through.
                layer = o.color * mask + o.color2 * (1 - mask)
                rgb = rgb * (1 - strength) + layer * strength
            else:
                rgb = rgb * (1 - mask * strength) + o.color * mask * strength
        self.overlays = live
        return rgb

    def step(self, dt: float) -> tuple[bytes, bytes]:
        """Advance one frame. Returns (display bytes for the 3D view, DDP packet)."""
        started = time.perf_counter()
        self.clock += dt
        ctx = self._make_ctx(dt)
        rgb = self.current.frame(ctx) if self.current else np.zeros((LED_COUNT, 3))
        if self.previous is not None and self.fade_left > 0:
            self.fade_left -= dt
            mix = max(0.0, self.fade_left / max(self.fade_total, 1e-6))
            rgb = rgb * (1 - mix) + self.previous.frame(ctx) * mix
            if self.fade_left <= 0:
                self.previous = None
        rgb = self._apply_overlays(rgb)
        g = self.globals
        if g.hue or g.saturation != 1.0:
            rgb = _hue_rotate(rgb, g.hue, g.saturation)
        rgb = np.clip(rgb * g.gain, 0, 1)
        display = (rgb * 255 + 0.5).astype(np.uint8)
        # Temporal dithering keeps slow dim fades smooth after gamma crushes them.
        linear = np.power(rgb, g.gamma) * 255 + self._error
        out = np.clip(np.round(linear), 0, 255)
        self._error = np.clip(linear - out, -0.5, 0.5)
        packet = self._packet
        out8 = out.astype(np.uint8)
        offset = len(DDP_HEADER)
        for led, cell in enumerate(self.geo.cells):
            base = offset + int(cell) * 3
            packet[base : base + 3] = out8[led].tobytes()
        self.render_ms += ((time.perf_counter() - started) * 1000 - self.render_ms) * 0.05
        return display.tobytes(), bytes(packet)

    # Loop

    def start(self) -> None:
        if self._task is None or self._task.done():
            self.running = True
            self._task = asyncio.get_running_loop().create_task(self._run(), name="glorb-engine")

    async def stop(self) -> None:
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        last = loop.time()
        deadline = last
        window_start = last
        sent = 0
        while self.running:
            now = loop.time()
            dt = min(0.2, now - last)
            last = now
            try:
                display, packet = self.step(dt)
                self.send(packet)
                sent += 1
                if now - window_start >= 1.0:
                    self.actual_fps = sent / (now - window_start)
                    sent, window_start = 0, now
                if self.on_frame:
                    self.on_frame(display)
            except Exception:  # keep the lamp alive through a bad effect
                _LOGGER.exception("Effect failed, stopping it")
                self.current = None
            deadline += 1 / self.fps
            delay = deadline - loop.time()
            if delay < -0.25:
                deadline = loop.time()
                delay = 0
            await asyncio.sleep(max(delay, 0))
