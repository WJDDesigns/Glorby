"""One physical lamp: its WLED connection, the effect engine and saved settings."""
from __future__ import annotations

import asyncio
import base64
from collections.abc import Callable
import io
import logging
import time
from typing import Any

import aiohttp
import numpy as np

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store

from .const import (
    DDP_PORT,
    DOMAIN,
    HEALTH_INTERVAL,
    HEALTH_MISSES,
    HEALTH_TIMEOUT,
    MAX_FPS,
    STORAGE_VERSION,
    VIEW_EVERY_SECONDS,
)
from .core.audio import AudioState, listen
from .core.effects import REGISTRY
from .core.engine import Engine
from .core.geometry import CELLS, MATRIX_H, MATRIX_W, build

_LOGGER = logging.getLogger(__name__)

SAVE_DELAY = 5
RECONNECT_SECONDS = 5
HEADER = 4  # 'L', version, width, height


class _Sender(asyncio.DatagramProtocol):
    def __init__(self) -> None:
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport) -> None:
        self.transport = transport


class GlorbDevice:
    def __init__(self, hass: HomeAssistant, entry_id: str, host: str, name: str, mac: str, fps: int) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self.host = host
        self.name = name
        self.mac = mac
        self.session = async_get_clientsession(hass)
        self.store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry_id}")
        self.saved: dict[str, Any] = {
            "looks": {},
            "params": {},
            "globals": {},
            "orientation": {"mirror": False, "flip": False, "rotation": 0.0},
            "resume": None,
        }
        self.engine = Engine(self._send, fps=min(fps, MAX_FPS), state_of=self._state_of)
        self.engine.on_frame = self._on_engine_frame
        self.audio_state = AudioState(self.engine.audio)
        self.wled_state: dict[str, Any] = {}
        self.wled_info: dict[str, Any] = {}
        self.wled_effects: list[str] = []
        self.wled_palettes: list[str] = []
        self.wled_presets: dict[str, str] = {}
        self.available = False
        self.fault: str | None = None
        self._sender = _Sender()
        self._audio_transport: asyncio.DatagramTransport | None = None
        self._tasks: list[asyncio.Task] = []
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._view_listeners: set[Callable[[str], None]] = set()
        self._state_listeners: set[Callable[[], None]] = set()
        self._last_view = 0.0
        self._last_time = time.monotonic()
        self._peek_on = False

    # Lifecycle

    async def async_start(self) -> None:
        stored = await self.store.async_load()
        if stored:
            self.saved.update(stored)
        self._apply_orientation()
        self.engine.set_globals(self.saved["globals"])
        await self.hass.loop.create_datagram_endpoint(
            lambda: self._sender, remote_addr=(self.host, DDP_PORT)
        )
        await self._load_catalog()
        self._tasks = [
            self.hass.async_create_background_task(self._ws_loop(), f"glorb-ws-{self.host}"),
            self.hass.async_create_background_task(self._health_loop(), f"glorb-health-{self.host}"),
        ]
        try:
            self._audio_transport = await listen(self.audio_state, self.host)
        except OSError as err:
            _LOGGER.warning("Could not listen for the lamp's microphone: %s", err)
        resume = self.saved.get("resume")
        if resume and resume["effect"] in REGISTRY:
            await self.async_play(resume["effect"], resume.get("params"))

    async def async_stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await self.engine.stop()
        if self._audio_transport:
            self._audio_transport.close()
        if self._sender.transport:
            self._sender.transport.close()
        if self._ws and not self._ws.closed:
            await self._ws.close()
        await self.store.async_save(self.saved)

    def _save(self) -> None:
        self.store.async_delay_save(lambda: self.saved, SAVE_DELAY)

    # Talking to the lamp

    def _send(self, packet: bytes) -> None:
        if self._sender.transport:
            self._sender.transport.sendto(packet)

    def _state_of(self, entity_id: str) -> tuple[str, dict[str, Any]] | None:
        state = self.hass.states.get(entity_id)
        return (state.state, dict(state.attributes)) if state else None

    async def _get(self, path: str) -> Any:
        async with self.session.get(
            f"http://{self.host}/{path}", timeout=aiohttp.ClientTimeout(total=HEALTH_TIMEOUT)
        ) as resp:
            return await resp.json(content_type=None)

    async def async_wled(self, payload: dict[str, Any], path: str = "json/state") -> None:
        async with self.session.post(
            f"http://{self.host}/{path}", json=payload, timeout=aiohttp.ClientTimeout(total=HEALTH_TIMEOUT)
        ) as resp:
            resp.raise_for_status()

    async def _load_catalog(self) -> None:
        try:
            self.wled_info = await self._get("json/info")
            self.wled_state = await self._get("json/state")
            self.wled_effects = await self._get("json/effects")
            self.wled_palettes = await self._get("json/palettes")
            presets = await self._get("presets.json")
            self.wled_presets = {k: v["n"] for k, v in presets.items() if isinstance(v, dict) and v.get("n")}
            self.available = True
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            _LOGGER.warning("Could not read the lamp at %s: %s", self.host, err)

    async def _ws_loop(self) -> None:
        """Stay connected for instant state updates and the firmware's live view."""
        while True:
            try:
                async with self.session.ws_connect(f"http://{self.host}/ws", heartbeat=30) as ws:
                    self._ws = ws
                    self._peek_on = False
                    await self._sync_peek()
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            self._on_ws_json(msg.json())
                        elif msg.type == aiohttp.WSMsgType.BINARY:
                            self._on_peek(msg.data)
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as err:
                _LOGGER.debug("Lamp connection lost: %s", err)
            self._ws = None
            await asyncio.sleep(RECONNECT_SECONDS)

    @callback
    def _on_ws_json(self, data: dict[str, Any]) -> None:
        if "state" in data:
            self.wled_state = data["state"]
        if "info" in data:
            self.wled_info = data["info"]
        self.available = True
        self.notify()

    async def _health_loop(self) -> None:
        """Stop streaming if the lamp stops answering, so a hang can't get worse."""
        misses = 0
        while True:
            await asyncio.sleep(HEALTH_INTERVAL)
            try:
                self.wled_info = await self._get("json/info")
                misses = 0
                self.available = True
                self.notify()
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                misses += 1
                if misses < HEALTH_MISSES:
                    continue
                if self.engine.running:
                    effect = self.engine.current.name if self.engine.current else "effect"
                    self.fault = f"The lamp stopped answering while playing {effect}"
                    _LOGGER.warning("%s, streaming stopped", self.fault)
                    await self.engine.stop()
                self.available = False
                self.notify()

    # Views

    @callback
    def add_view_listener(self, listener: Callable[[str], None]) -> Callable[[], None]:
        self._view_listeners.add(listener)
        self.hass.async_create_task(self._sync_peek())

        @callback
        def remove() -> None:
            self._view_listeners.discard(listener)
            self.hass.async_create_task(self._sync_peek())

        return remove

    @callback
    def add_state_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._state_listeners.add(listener)
        return lambda: self._state_listeners.discard(listener)

    @callback
    def notify(self) -> None:
        for listener in list(self._state_listeners):
            listener()

    async def _sync_peek(self) -> None:
        want = bool(self._view_listeners) and not self.engine.running
        if self._ws is None or self._ws.closed or want == self._peek_on:
            return
        await self._ws.send_json({"lv": want})
        self._peek_on = want

    def _send_view(self, frame: bytes) -> None:
        encoded = base64.b64encode(frame).decode()
        for listener in list(self._view_listeners):
            listener(encoded)

    def _on_engine_frame(self, display: bytes) -> None:
        now = time.monotonic()
        self.audio_state.decay(now - self._last_time, self.hass.loop.time())
        self._last_time = now
        if self._view_listeners and now - self._last_view >= VIEW_EVERY_SECONDS:
            self._last_view = now
            self._send_view(display)

    def _on_peek(self, data: bytes) -> None:
        """Turn the firmware's live view into our LED order for the 3D model."""
        if self.engine.running or len(data) < HEADER + CELLS * 3 or data[0] != ord("L"):
            return
        if data[1] != 2 or data[2] != MATRIX_W or data[3] != MATRIX_H:
            return
        pixels = np.frombuffer(data, dtype=np.uint8, count=CELLS * 3, offset=HEADER).reshape(-1, 3)
        self._send_view(pixels[self.engine.geo.cells].tobytes())

    # Effects

    async def async_play(
        self, effect_id: str, params: dict[str, Any] | None = None, transition: float | None = None
    ) -> None:
        merged = {**self.saved["params"].get(effect_id, {}), **(params or {})}
        fx = self.engine.play(effect_id, merged, transition=transition)
        self.fault = None
        self.engine.start()
        await self._sync_peek()
        self._remember()
        if fx.category == "Music":
            await self._ensure_mic()
        if fx.p.get("source"):
            await self.async_load_picture(str(fx.p["source"]))
        self.notify()

    async def async_alert(self, pattern: str, color: str, color2: str, duration: float, opacity: float = 1.0) -> None:
        """Play an alert over the current effect."""
        if not self.engine.running:
            # Alerts need the engine, so give the lamp back to its own effect afterward.
            resume = self.saved.get("resume")
            await self.async_play("solid", {"color": "#000000"}, 0)
            self.saved["resume"] = resume
            self.hass.loop.call_later(duration, lambda: self.hass.async_create_task(self._end_alert()))
        self.engine.alert(pattern, color, color2, duration, opacity)

    async def _end_alert(self) -> None:
        if not self.engine.overlays or self.engine.overlays[-1].started + self.engine.overlays[-1].duration <= self.engine.clock + 0.2:
            await self.async_release()

    async def async_set_params(self, values: dict[str, Any]) -> None:
        self.engine.set_params(values)
        self._remember()
        if "source" in values and values["source"]:
            await self.async_load_picture(str(values["source"]))
        self.notify()

    def async_set_globals(self, values: dict[str, Any]) -> None:
        self.engine.set_globals(values)
        self.saved["globals"] = dict(self.engine.snapshot()["globals"])
        self._save()
        self.notify()

    def _remember(self) -> None:
        fx = self.engine.current
        if fx is None:
            return
        self.saved["params"][fx.id] = dict(fx.p)
        self.saved["resume"] = {"effect": fx.id, "params": dict(fx.p)}
        self._save()

    async def async_release(self) -> None:
        """Hand the lamp back to its own firmware."""
        await self.engine.stop()
        self.saved["resume"] = None
        self._save()
        try:
            await self.async_wled({"live": False})
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            _LOGGER.debug("Could not release the lamp: %s", err)
        await self._sync_peek()
        self.notify()

    async def async_play_wled(self, *, fx: int | None = None, preset: int | None = None, seg: dict[str, Any] | None = None) -> None:
        await self.engine.stop()
        self.saved["resume"] = None
        self._save()
        payload: dict[str, Any] = {"live": False, "on": True}
        if preset is not None:
            payload["ps"] = preset
        if fx is not None:
            payload["seg"] = [{"id": 0, "fx": fx}]
        if seg:
            payload["seg"] = [{"id": 0, **seg}]
        await self.async_wled(payload)
        await self._sync_peek()
        self.notify()

    async def _ensure_mic(self) -> None:
        """Have the lamp broadcast its microphone. Only writes when it isn't already."""
        try:
            cfg = await self._get("json/cfg")
            if cfg["um"]["AudioReactive"]["sync"]["mode"] != 1:
                await self.async_wled({"um": {"AudioReactive": {"sync": {"mode": 1}}}}, "json/cfg")
        except (aiohttp.ClientError, asyncio.TimeoutError, KeyError, ValueError) as err:
            _LOGGER.warning("Could not turn on the lamp's microphone stream: %s", err)

    async def async_load_picture(self, source: str) -> None:
        fx = self.engine.current
        if fx is None or fx.id != "picture":
            return
        try:
            if source.startswith(("http://", "https://")):
                async with self.session.get(source, timeout=aiohttp.ClientTimeout(total=20)) as resp:
                    resp.raise_for_status()
                    data = await resp.read()
            else:
                if not self.hass.config.is_allowed_path(source):
                    raise ValueError(f"{source} is not in allowlist_external_dirs")
                data = await self.hass.async_add_executor_job(_read_file, source)
            fx.image = await self.hass.async_add_executor_job(_decode_image, data)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as err:
            _LOGGER.warning("Could not load %s: %s", source, err)

    # Looks

    def save_look(self, name: str) -> None:
        fx = self.engine.current
        if fx is None:
            raise ValueError("No effect is playing")
        self.saved["looks"][name] = {
            "effect": fx.id,
            "params": dict(fx.p),
            "globals": dict(self.engine.snapshot()["globals"]),
        }
        self._save()
        self.notify()

    def delete_look(self, name: str) -> None:
        self.saved["looks"].pop(name, None)
        self._save()
        self.notify()

    async def async_play_look(self, name: str) -> None:
        look = self.saved["looks"][name]
        self.async_set_globals(look.get("globals", {}))
        await self.async_play(look["effect"], look.get("params"))

    # Orientation

    def _apply_orientation(self) -> None:
        o = self.saved["orientation"]
        self.engine.set_geometry(
            build(mirror=bool(o["mirror"]), flip=bool(o["flip"]), rotation_deg=float(o["rotation"]))
        )

    def set_orientation(self, values: dict[str, Any]) -> None:
        self.saved["orientation"].update(values)
        self._apply_orientation()
        self._save()
        self.notify()

    # Snapshots for the frontend

    def geometry(self) -> dict[str, Any]:
        geo = self.engine.geo
        return {
            "vertices": np.round(geo.vertices, 5).tolist(),
            "faces": geo.faces.tolist(),
        }

    def state(self) -> dict[str, Any]:
        seg = (self.wled_state.get("seg") or [{}])[0]
        return {
            **self.engine.snapshot(),
            "available": self.available,
            "fault": self.fault,
            "on": bool(self.wled_state.get("on")),
            "bri": int(self.wled_state.get("bri", 0)),
            "wled": {
                "fx": seg.get("fx"),
                "sx": seg.get("sx"),
                "ix": seg.get("ix"),
                "pal": seg.get("pal"),
                "ps": self.wled_state.get("ps"),
                "ver": self.wled_info.get("ver"),
                "signal": (self.wled_info.get("wifi") or {}).get("signal"),
                "power": (self.wled_info.get("leds") or {}).get("pwr"),
            },
            "looks": sorted(self.saved["looks"]),
            "orientation": self.saved["orientation"],
        }


def _read_file(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def _decode_image(data: bytes) -> np.ndarray:
    from PIL import Image  # pylint: disable=import-outside-toplevel

    with Image.open(io.BytesIO(data)) as img:
        return np.asarray(img.convert("RGB").resize((360, 180)), dtype=float) / 255.0
