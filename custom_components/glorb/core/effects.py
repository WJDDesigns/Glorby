"""Effects are functions of position on the sphere, not positions along a strip.

An effect gets every LED's 3D direction and returns a color for each. Nothing in
here knows about rows, chains or the matrix, which is what lets a shape cross
the sphere as a shape.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import math
from typing import Any, Callable

import numpy as np

from . import palettes
from .geometry import LED_COUNT, Geometry

CATEGORIES = ("Worlds", "Faces", "Ambient", "Geometry", "Music", "Data", "Basics")


@dataclass
class Audio:
    """What the lamp's microphone is hearing, each 0..1."""

    active: bool = False
    level: float = 0.0
    bass: float = 0.0
    mid: float = 0.0
    treble: float = 0.0
    beat: float = 0.0  # jumps to 1 on a beat, then decays
    bins: np.ndarray = field(default_factory=lambda: np.zeros(16))


@dataclass
class Ctx:
    pos: np.ndarray
    lat: np.ndarray
    lon: np.ndarray
    t: float
    dt: float
    audio: Audio
    state_of: Callable[[str], tuple[str, dict[str, Any]] | None]
    now: datetime


@dataclass(frozen=True)
class Param:
    key: str
    name: str
    kind: str  # range, choice, color, bool, entity, text
    default: Any
    min: float = 0.0
    max: float = 1.0
    step: float = 0.01
    options: tuple[str, ...] = ()

    def clean(self, value: Any) -> Any:
        if self.kind == "range":
            return float(min(self.max, max(self.min, float(value))))
        if self.kind == "bool":
            return bool(value)
        if self.kind == "choice":
            return value if value in self.options else self.default
        return str(value)

    def describe(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "key": self.key, "name": self.name, "kind": self.kind, "default": self.default
        }
        if self.kind == "range":
            out.update(min=self.min, max=self.max, step=self.step)
        if self.kind == "choice":
            out["options"] = list(self.options)
        return out


def _speed(default: float = 1.0) -> Param:
    return Param("speed", "Speed", "range", default, 0.0, 4.0, 0.05)


def _palette(default: str) -> Param:
    return Param("palette", "Palette", "choice", default, options=tuple(palettes.NAMES))


def _facing() -> Param:
    return Param("facing", "Facing", "range", 0.0, -180.0, 180.0, 1.0)


def _smooth(low: float, high: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - low) / (high - low), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _angle(pos: np.ndarray, direction: np.ndarray) -> np.ndarray:
    return np.arccos(np.clip(pos @ direction, -1.0, 1.0))


def _dir(lat_deg: float, lon_deg: float) -> np.ndarray:
    la, lo = math.radians(lat_deg), math.radians(lon_deg)
    return np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])


def _unit(v: np.ndarray) -> np.ndarray:
    return v / max(float(np.linalg.norm(v)), 1e-9)


_PERM_RNG = np.random.default_rng(1337)
_PERM = _PERM_RNG.permutation(256)
_PERM = np.concatenate([_PERM, _PERM, _PERM])
_GRAD = _PERM_RNG.normal(size=(256, 3))
_GRAD /= np.linalg.norm(_GRAD, axis=1, keepdims=True)


def noise3(p: np.ndarray) -> np.ndarray:
    """Gradient noise, roughly -1..1."""
    cell = np.floor(p).astype(int)
    f = p - cell
    u = f * f * f * (f * (f * 6 - 15) + 10)
    cell &= 255
    out = np.zeros(len(p))
    for dx in (0, 1):
        wx = u[:, 0] if dx else 1 - u[:, 0]
        for dy in (0, 1):
            wy = u[:, 1] if dy else 1 - u[:, 1]
            for dz in (0, 1):
                wz = u[:, 2] if dz else 1 - u[:, 2]
                h = _PERM[_PERM[_PERM[cell[:, 0] + dx] + cell[:, 1] + dy] + cell[:, 2] + dz]
                grad = _GRAD[h % 256]
                dot = (
                    grad[:, 0] * (f[:, 0] - dx)
                    + grad[:, 1] * (f[:, 1] - dy)
                    + grad[:, 2] * (f[:, 2] - dz)
                )
                out += wx * wy * wz * dot
    return out * 1.9


def fbm(p: np.ndarray, octaves: int = 3) -> np.ndarray:
    total, amp, norm = np.zeros(len(p)), 1.0, 0.0
    for _ in range(octaves):
        total += noise3(p) * amp
        norm += amp
        amp *= 0.5
        p = p * 2.03 + 11.7
    return total / norm


def _nearest(forward: np.ndarray, right: np.ndarray, up: np.ndarray, points: list[tuple[float, float]]) -> np.ndarray:
    """Pick the one triangle closest to each (right, up) point.

    At 80 triangles a drawn shape blurs into a blob. Features chosen triangle by
    triangle stay crisp, and still work at any facing or spin.
    """
    mask = np.zeros(LED_COUNT, dtype=bool)
    for r, u in points:
        f = math.sqrt(max(0.0, 1.0 - r * r - u * u))
        mask[int(np.argmax(forward * f + right * r + up * u))] = True
    return mask


REGISTRY: dict[str, type["Effect"]] = {}


def effect(cls: type["Effect"]) -> type["Effect"]:
    REGISTRY[cls.id] = cls
    return cls


class Effect:
    id = ""
    name = ""
    category = "Ambient"
    params: tuple[Param, ...] = ()

    def __init__(self, geo: Geometry, rng: np.random.Generator) -> None:
        self.geo = geo
        self.rng = rng
        self.clock = 0.0
        self.p: dict[str, Any] = {x.key: x.default for x in self.params}

    def set(self, values: dict[str, Any]) -> None:
        known = {x.key: x for x in self.params}
        for key, value in values.items():
            if key in known:
                self.p[key] = known[key].clean(value)

    def frame(self, ctx: Ctx) -> np.ndarray:
        self.clock += ctx.dt * float(self.p.get("speed", 1.0))
        return np.clip(self.render(ctx), 0.0, 1.0)

    def render(self, ctx: Ctx) -> np.ndarray:
        raise NotImplementedError

    def _view(self, ctx: Ctx) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Coordinates for things drawn on the front: forward, right, up."""
        a = math.radians(float(self.p.get("facing", 0.0)))
        forward = ctx.pos[:, 0] * math.cos(a) + ctx.pos[:, 1] * math.sin(a)
        right = -ctx.pos[:, 0] * math.sin(a) + ctx.pos[:, 1] * math.cos(a)
        return forward, right, ctx.pos[:, 2]

    @classmethod
    def describe(cls) -> dict[str, Any]:
        return {
            "id": cls.id,
            "name": cls.name,
            "category": cls.category,
            "params": [x.describe() for x in cls.params],
        }


# --- Worlds ------------------------------------------------------------------


_LAND = [
    (48, -100, 27), (24, -100, 11), (64, -125, 16), (15, -86, 6),
    (-12, -58, 20), (-34, -66, 10), (6, -70, 9),
    (6, 21, 22), (24, 12, 17), (-22, 25, 12), (8, 40, 8),
    (50, 15, 12), (62, 25, 9),
    (52, 95, 30), (24, 80, 11), (24, 108, 12), (66, 110, 16), (36, 55, 10), (-2, 115, 7),
    (-25, 134, 12), (72, -40, 9),
]


@effect
class Earth(Effect):
    id = "earth"
    name = "Earth"
    category = "Worlds"
    params = (
        Param("spin", "Spin", "range", 1.0, -6.0, 6.0, 0.05),
        Param("real_sun", "Real daylight", "bool", True),
        Param("night", "Night glow", "range", 0.35, 0.0, 1.0, 0.01),
    )

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.turn = 0.0

    def render(self, ctx):
        self.turn += ctx.dt * self.p["spin"] * 0.15
        cos_t, sin_t = math.cos(self.turn), math.sin(self.turn)
        x = ctx.pos[:, 0] * cos_t + ctx.pos[:, 1] * sin_t
        y = -ctx.pos[:, 0] * sin_t + ctx.pos[:, 1] * cos_t
        p = np.stack([x, y, ctx.pos[:, 2]], axis=1)
        land = np.zeros(LED_COUNT)
        for lat, lon, radius in _LAND:
            land = np.maximum(land, 1 - _smooth(radius * 0.7, radius * 1.15, np.degrees(_angle(p, _dir(lat, lon)))))
        ice = _smooth(62, 76, np.abs(np.degrees(np.arcsin(np.clip(p[:, 2], -1, 1)))))
        sea = np.array([0.0, 0.14, 0.55])
        ground = np.array([0.08, 0.5, 0.12])
        desert = np.array([0.72, 0.5, 0.16])
        lat_abs = np.abs(p[:, 2])
        dry = _smooth(0.15, 0.3, lat_abs) * (1 - _smooth(0.4, 0.6, lat_abs))
        rgb = (ground * (1 - dry[:, None]) + desert * dry[:, None]) * land[:, None] + sea * (1 - land[:, None])
        rgb = rgb * (1 - ice[:, None]) + ice[:, None] * 0.95
        clouds = _smooth(0.2, 0.55, fbm(p * 2.2 + np.array([ctx.t * 0.03, 0, 0]), 2))
        rgb = rgb * (1 - clouds[:, None] * 0.6) + clouds[:, None] * 0.6
        if self.p["real_sun"]:
            sub_lat, sub_lon = subsolar_point(ctx.now)
        else:
            sub_lat, sub_lon = 15.0, math.degrees(ctx.t * 0.1)
        day = _smooth(-0.12, 0.2, p @ _dir(sub_lat, sub_lon))
        cities = land * (1 - day) * self.p["night"] * (0.6 + 0.4 * noise3(p * 7))
        dark = np.array([0.0, 0.01, 0.05])
        out = rgb * (0.04 + 0.96 * day[:, None]) + dark * (1 - day[:, None])
        return out + cities[:, None] * np.array([1.0, 0.65, 0.25])


def subsolar_point(now: datetime) -> tuple[float, float]:
    """Where the sun is directly overhead right now."""
    now = now.astimezone(timezone.utc)
    day = now.timetuple().tm_yday
    hours = now.hour + now.minute / 60 + now.second / 3600
    declination = -23.44 * math.cos(math.radians(360 / 365 * (day + 10)))
    return declination, (12 - hours) * 15


def moon_phase(now: datetime) -> float:
    """0 is new moon, 0.5 is full."""
    new_moon = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
    return ((now.astimezone(timezone.utc) - new_moon).total_seconds() / 86400 / 29.530588) % 1.0


@effect
class Moon(Effect):
    id = "moon"
    name = "Moon"
    category = "Worlds"
    params = (
        Param("real_phase", "Tonight's phase", "bool", True),
        Param("phase", "Phase", "range", 0.5, 0.0, 1.0, 0.01),
        _facing(),
        Param("earthshine", "Earthshine", "range", 0.06, 0.0, 0.3, 0.01),
    )

    def render(self, ctx):
        phase = moon_phase(ctx.now) if self.p["real_phase"] else self.p["phase"]
        forward, right, _ = self._view(ctx)
        a = phase * 2 * math.pi
        lit = _smooth(-0.1, 0.1, forward * -math.cos(a) + right * math.sin(a))
        surface = 0.62 + 0.38 * fbm(ctx.pos * 2.6, 3)
        tone = np.clip(surface, 0, 1)[:, None] * np.array([1.0, 0.97, 0.88])
        return tone * (self.p["earthshine"] + (1 - self.p["earthshine"]) * lit[:, None])


@effect
class Sun(Effect):
    id = "sun"
    name = "Sun"
    category = "Worlds"
    params = (_speed(), Param("activity", "Activity", "range", 0.5, 0.0, 1.0, 0.01))

    def render(self, ctx):
        heat = np.clip(0.5 + 1.1 * fbm(ctx.pos * 2.4 + np.array([0, 0, self.clock * 0.25]), 3), 0, 1)
        flare = _smooth(0.62 - self.p["activity"] * 0.3, 0.9, 0.5 + 0.5 * noise3(ctx.pos * 1.6 + self.clock * 0.4))
        return palettes.sample("Ember", 0.38 + 0.42 * heat + 0.25 * flare)


@effect
class Jupiter(Effect):
    id = "jupiter"
    name = "Jupiter"
    category = "Worlds"
    params = (_speed(), Param("spot", "Red spot", "bool", True))

    def render(self, ctx):
        turn = self.clock * 0.25
        p = np.stack(
            [
                ctx.pos[:, 0] * math.cos(turn) + ctx.pos[:, 1] * math.sin(turn),
                -ctx.pos[:, 0] * math.sin(turn) + ctx.pos[:, 1] * math.cos(turn),
                ctx.pos[:, 2],
            ],
            axis=1,
        )
        wobble = 0.12 * noise3(p * np.array([2.4, 2.4, 5.0]))
        band = 0.5 + 0.5 * np.sin((p[:, 2] + wobble) * 9.5)
        light = np.array([0.95, 0.82, 0.6])
        dark = np.array([0.55, 0.26, 0.1])
        rgb = dark + (light - dark) * band[:, None]
        if self.p["spot"]:
            spot = 1 - _smooth(0.28, 0.5, _angle(p, _dir(-22, 0)))
            rgb = rgb * (1 - spot[:, None]) + np.array([0.85, 0.12, 0.03]) * spot[:, None]
        return rgb


@effect
class Basketball(Effect):
    id = "basketball"
    name = "Basketball"
    category = "Worlds"
    params = (Param("spin", "Spin", "range", 1.0, -6.0, 6.0, 0.05), Param("tilt", "Tilt", "range", 20.0, -90.0, 90.0, 1.0))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.turn = 0.0

    def render(self, ctx):
        self.turn += ctx.dt * self.p["spin"] * 0.8
        t = math.radians(self.p["tilt"])
        y = ctx.pos[:, 1] * math.cos(t) - ctx.pos[:, 2] * math.sin(t)
        z = ctx.pos[:, 1] * math.sin(t) + ctx.pos[:, 2] * math.cos(t)
        x = ctx.pos[:, 0]
        a = x * math.cos(self.turn) - z * math.sin(self.turn)
        c = x * math.sin(self.turn) + z * math.cos(self.turn)
        seam = np.minimum.reduce([np.abs(y), np.abs(a), np.abs(np.abs(c) - 0.62 - 0.3 * y * y)])
        leather = np.array([0.95, 0.32, 0.03])
        return leather * (0.08 + 0.92 * _smooth(0.02, 0.11, seam))[:, None]


@effect
class Pumpkin(Effect):
    id = "pumpkin"
    name = "Pumpkin"
    category = "Worlds"
    params = (_facing(), Param("flicker", "Candle flicker", "range", 0.7, 0.0, 1.0, 0.01))

    def render(self, ctx):
        forward, right, up = self._view(ctx)
        ribs = 0.62 + 0.38 * np.abs(np.cos(ctx.lon * 5))
        skin = np.array([0.8, 0.24, 0.01]) * ribs[:, None]
        cut = _nearest(
            forward,
            right,
            up,
            [
                (-0.42, 0.4), (-0.3, 0.2), (0.42, 0.4), (0.3, 0.2),  # eyes
                (0.0, 0.05),  # nose
                (-0.7, -0.2), (-0.45, -0.45), (-0.15, -0.6), (0.15, -0.6), (0.45, -0.45), (0.7, -0.2),  # grin
            ],
        )
        flame = 1 - self.p["flicker"] * 0.55 * (0.5 + 0.5 * math.sin(ctx.t * 13.0) * math.sin(ctx.t * 7.3))
        glow = np.array([1.0, 0.82, 0.2]) * flame
        return np.where(cut[:, None], glow, skin * 0.5)


# --- Faces -------------------------------------------------------------------


@effect
class Eye(Effect):
    id = "eye"
    name = "Eye"
    category = "Faces"
    params = (
        _facing(),
        Param("iris", "Iris", "color", "#19c8ff"),
        Param("sclera", "White", "color", "#c8c0b4"),
        Param("track", "Look around", "bool", True),
        Param("look_x", "Look left and right", "range", 0.0, -1.0, 1.0, 0.01),
        Param("look_y", "Look up and down", "range", 0.0, -1.0, 1.0, 0.01),
        Param("pupil", "Pupil", "range", 0.3, 0.1, 0.6, 0.01),
        Param("blink", "Blinks", "bool", True),
    )

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.gaze = np.array([0.0, 0.0])
        self.target = np.array([0.0, 0.0])
        self.next_look = 0.0
        self.next_blink = 2.0
        self.blink_at = -9.0

    def render(self, ctx):
        forward, right, up = self._view(ctx)
        if self.p["track"]:
            if ctx.t > self.next_look:
                self.target = self.rng.uniform(-0.8, 0.8, 2) * np.array([1.0, 0.6])
                self.next_look = ctx.t + float(self.rng.uniform(0.8, 3.2))
        else:
            self.target = np.array([self.p["look_x"], self.p["look_y"]])
        self.gaze += (self.target - self.gaze) * min(1.0, ctx.dt * 12)
        if self.p["blink"] and ctx.t > self.next_blink:
            self.blink_at = ctx.t
            self.next_blink = ctx.t + float(self.rng.uniform(2.0, 6.0))
        since = ctx.t - self.blink_at
        closed = max(0.0, 1.0 - abs(since - 0.11) / 0.11)
        gx, gy = float(self.gaze[0]), float(self.gaze[1])
        gaze = _unit(np.array([1.0, gx * 0.9, gy * 0.9]))
        p = np.stack([forward, right, up], axis=1)
        a = _angle(p, gaze)
        pupil = float(self.p["pupil"])
        rgb = np.tile(palettes.color(self.p["sclera"]), (LED_COUNT, 1))
        rgb *= (0.35 + 0.65 * _smooth(-0.4, 0.5, forward))[:, None]
        iris = 1 - _smooth(pupil + 0.42, pupil + 0.62, a)
        color = palettes.color(self.p["iris"]) * (0.65 + 0.35 * np.cos(a * 9))[:, None]
        rgb = rgb * (1 - iris[:, None]) + color * iris[:, None]
        dark = 1 - _smooth(pupil * 0.9, pupil + 0.18, a)
        rgb = rgb * (1 - dark[:, None])
        lid = _smooth(0.0, 0.25, 1.0 - closed * 1.05 - np.abs(up) * (1.0 - 0.1))
        skin = np.array([0.22, 0.06, 0.04])
        return rgb * lid[:, None] + skin * (1 - lid[:, None])


@effect
class Face(Effect):
    id = "face"
    name = "Face"
    category = "Faces"
    params = (
        _facing(),
        Param("mood", "Mood", "choice", "Happy", options=("Happy", "Sad", "Surprised", "Wink", "Angry", "Sleepy")),
        Param("skin", "Skin", "color", "#ffc400"),
        Param("feature", "Features", "color", "#180800"),
        Param("bob", "Bob", "range", 0.3, 0.0, 1.0, 0.01),
    )

    def render(self, ctx):
        forward, right, up = self._view(ctx)
        bob = float(self.p["bob"])
        right = right + math.sin(ctx.t * 0.9) * 0.1 * bob
        up = up - math.sin(ctx.t * 1.6) * 0.04 * bob
        mood = self.p["mood"]
        blink = (ctx.t % 4.1) < 0.14
        points: list[tuple[float, float]] = []
        for side in (-1, 1):
            closed = blink or mood == "Sleepy" or (mood == "Wink" and side == 1)
            if not closed:
                points.append((side * 0.4, 0.35))
            if mood == "Surprised":
                points.append((side * 0.4, 0.55))
            if mood == "Angry":
                points.append((side * 0.22, 0.42))
        mouths = {
            "Happy": [(-0.65, -0.15), (-0.4, -0.45), (-0.13, -0.6), (0.13, -0.6), (0.4, -0.45), (0.65, -0.15)],
            "Wink": [(-0.65, -0.15), (-0.4, -0.45), (-0.13, -0.6), (0.13, -0.6), (0.4, -0.45), (0.65, -0.15)],
            "Sad": [(-0.5, -0.65), (-0.25, -0.4), (0.25, -0.4), (0.5, -0.65)],
            "Angry": [(-0.4, -0.5), (0.0, -0.5), (0.4, -0.5)],
            "Sleepy": [(0.0, -0.5)],
            "Surprised": [(0.0, -0.45), (0.0, -0.7)],
        }
        points += mouths[mood]
        marks = _nearest(forward, right, up, points)
        skin = palettes.color(self.p["skin"]) * (0.55 + 0.45 * _smooth(-1.0, 0.2, forward))[:, None]
        return np.where(marks[:, None], palettes.color(self.p["feature"]), skin)


# --- Ambient -----------------------------------------------------------------


@effect
class Aurora(Effect):
    id = "aurora"
    name = "Aurora"
    category = "Ambient"
    params = (_speed(), _palette("Aurora"), Param("height", "Height", "range", 0.3, -1.0, 1.0, 0.01))

    def render(self, ctx):
        curtain = fbm(np.stack([ctx.pos[:, 0] * 1.4, ctx.pos[:, 1] * 1.4, np.full(LED_COUNT, self.clock * 0.25)], axis=1), 3)
        band = np.exp(-(((ctx.pos[:, 2] - self.p["height"] - curtain * 0.35) / 0.42) ** 2))
        shimmer = 0.6 + 0.4 * np.sin(ctx.lon * 7 + self.clock * 2 + curtain * 7)
        return palettes.sample(self.p["palette"], 0.25 + band * 0.55 + curtain * 0.2) * (band * shimmer)[:, None]


@effect
class Nebula(Effect):
    id = "nebula"
    name = "Nebula"
    category = "Ambient"
    params = (_speed(0.6), _palette("Vaporwave"), Param("scale", "Scale", "range", 1.5, 0.4, 4.0, 0.05))

    def render(self, ctx):
        warp = fbm(ctx.pos * self.p["scale"] + self.clock * 0.1, 2)
        field_ = fbm(ctx.pos * self.p["scale"] + warp[:, None] * 1.2 + np.array([0, self.clock * 0.08, 0]), 3)
        return palettes.sample(self.p["palette"], 0.5 + field_ * 0.9, wrap=True) * _smooth(-0.45, 0.25, field_)[:, None]


@effect
class Plasma(Effect):
    id = "plasma"
    name = "Plasma"
    category = "Ambient"
    params = (_speed(), _palette("Neon"), Param("scale", "Scale", "range", 2.5, 0.5, 8.0, 0.05))

    def render(self, ctx):
        s, t = self.p["scale"], self.clock
        p = ctx.pos
        v = np.sin(p[:, 0] * s + t) + np.sin(p[:, 1] * s * 0.8 - t * 1.3) + np.sin(p[:, 2] * s * 1.2 + t * 0.7) + np.sin((p[:, 0] + p[:, 1] + p[:, 2]) * s * 0.7 + t * 1.7)
        return palettes.sample(self.p["palette"], v * 0.125 + 0.5 + t * 0.03, wrap=True)


@effect
class Lava(Effect):
    id = "lava"
    name = "Lava Lamp"
    category = "Ambient"
    params = (_speed(), _palette("Lava"), Param("blobs", "Blobs", "range", 5, 2, 9, 1))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.seed = rng.uniform(0, 100, (9, 3))

    def render(self, ctx):
        count = int(self.p["blobs"])
        total = np.zeros(LED_COUNT)
        for i in range(count):
            s = self.seed[i]
            center = 0.75 * np.array(
                [math.sin(self.clock * 0.21 + s[0]), math.sin(self.clock * 0.17 + s[1]), math.sin(self.clock * (0.13 + i * 0.015) + s[2])]
            )
            total += 0.22 / (np.sum((ctx.pos - center) ** 2, axis=1) + 0.05)
        return palettes.sample(self.p["palette"], 0.5 + (total - total.mean()) * 1.1)


@effect
class Ocean(Effect):
    id = "ocean"
    name = "Deep Ocean"
    category = "Ambient"
    params = (_speed(), _palette("Ocean"))

    def render(self, ctx):
        a = fbm(ctx.pos * 2.2 + np.array([self.clock * 0.2, 0, self.clock * 0.12]), 2)
        b = fbm(ctx.pos * 2.9 - np.array([0, self.clock * 0.16, self.clock * 0.1]), 2)
        caustic = 1 - np.abs(a - b) * 3.2
        depth = 0.25 + 0.4 * _smooth(-1, 1, ctx.pos[:, 2])
        return palettes.sample(self.p["palette"], depth + np.clip(caustic, 0, 1) ** 3 * 0.55)


@effect
class Fire(Effect):
    id = "fire"
    name = "Fireball"
    category = "Ambient"
    params = (_speed(1.2), _palette("Ember"), Param("height", "Flame height", "range", 0.65, 0.1, 1.0, 0.01))

    def render(self, ctx):
        n = fbm(ctx.pos * np.array([2.5, 2.5, 1.3]) - np.array([0, 0, self.clock * 1.1]), 3)
        h = (ctx.pos[:, 2] + 1) / 2
        return palettes.sample(self.p["palette"], 1.05 - h * (1.25 - self.p["height"]) + n * 0.45)


@effect
class Stars(Effect):
    id = "stars"
    name = "Starfield"
    category = "Ambient"
    params = (_speed(), Param("density", "Density", "range", 0.25, 0.02, 1.0, 0.01), Param("tint", "Tint", "color", "#cfe3ff"), Param("sky", "Night sky", "color", "#02030a"))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.v = rng.uniform(0, 1, LED_COUNT)

    def render(self, ctx):
        spawn = self.rng.random(LED_COUNT) < self.p["density"] * ctx.dt * self.p["speed"] * 2.5
        self.v = np.where(spawn, 1.0, self.v * math.exp(-ctx.dt * self.p["speed"] * 1.3))
        return palettes.color(self.p["sky"]) + palettes.color(self.p["tint"]) * (self.v * self.v)[:, None]


# --- Geometry ----------------------------------------------------------------


class _Trail(Effect):
    """Adds a fading trail for anything that draws with sharp moving edges."""

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.buffer = np.zeros((LED_COUNT, 3))

    def _fade(self, ctx: Ctx, decay: float) -> None:
        self.buffer *= math.exp(-ctx.dt * decay)


@effect
class Scanner(_Trail):
    id = "scanner"
    name = "Plane Scanner"
    category = "Geometry"
    params = (_speed(), _palette("Neon"), Param("width", "Width", "range", 0.25, 0.08, 0.8, 0.01), Param("trail", "Trail", "range", 3.0, 0.5, 12.0, 0.1))

    def render(self, ctx):
        c = self.clock
        normal = _unit(np.array([math.sin(c * 0.61), math.cos(c * 0.43), math.sin(c * 0.29 + 1.0)]))
        hit = 1 - _smooth(0.0, self.p["width"], np.abs(ctx.pos @ normal))
        self._fade(ctx, self.p["trail"])
        color = palettes.sample(self.p["palette"], c * 0.06 + (ctx.pos[:, 2] + 1) * 0.12, wrap=True)
        self.buffer = np.maximum(self.buffer, color * hit[:, None])
        return self.buffer


@effect
class Comets(_Trail):
    id = "comets"
    name = "Comets"
    category = "Geometry"
    params = (_speed(), _palette("Rainbow"), Param("count", "Count", "range", 3, 1, 8, 1), Param("trail", "Trail", "range", 2.0, 0.5, 8.0, 0.1))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        axes = rng.normal(size=(8, 3))
        self.axes = axes / np.linalg.norm(axes, axis=1, keepdims=True)

    def render(self, ctx):
        self._fade(ctx, self.p["trail"])
        for i in range(int(self.p["count"])):
            axis = self.axes[i]
            ref = _unit(np.cross(axis, [0.3, 0.5, 0.8]))
            other = np.cross(axis, ref)
            a = self.clock * (1.1 + i * 0.13) + i * 2.1
            head = ref * math.cos(a) + other * math.sin(a)
            lit = 1 - _smooth(0.12, 0.42, _angle(ctx.pos, head))
            color = palettes.sample(self.p["palette"], np.array([i / 8 + self.clock * 0.02]), wrap=True)[0]
            self.buffer = np.maximum(self.buffer, color * lit[:, None])
        return self.buffer


@effect
class Orbits(Effect):
    id = "orbits"
    name = "Gyroscope"
    category = "Geometry"
    params = (_speed(), _palette("Royal"), Param("rings", "Rings", "range", 3, 1, 5, 1), Param("width", "Width", "range", 0.2, 0.08, 0.5, 0.01))

    def render(self, ctx):
        out = np.zeros((LED_COUNT, 3))
        for i in range(int(self.p["rings"])):
            c = self.clock * (0.6 + i * 0.23) + i * 1.9
            normal = _unit(np.array([math.sin(c), math.cos(c * 0.8 + i), math.sin(c * 0.5 + i * 2)]))
            ring = 1 - _smooth(0.0, self.p["width"], np.abs(ctx.pos @ normal))
            color = palettes.sample(self.p["palette"], np.array([0.3 + i / 6]), wrap=True)[0]
            out = np.maximum(out, color * ring[:, None])
        return out


@effect
class Spiral(Effect):
    id = "spiral"
    name = "Barber Spiral"
    category = "Geometry"
    params = (_speed(), _palette("Candy"), Param("arms", "Arms", "range", 2, 1, 6, 1), Param("twist", "Twist", "range", 4.0, 0.0, 12.0, 0.1))

    def render(self, ctx):
        phase = ctx.lon * self.p["arms"] / (2 * math.pi) + ctx.pos[:, 2] * self.p["twist"] * 0.25 - self.clock * 0.4
        return palettes.sample(self.p["palette"], phase, wrap=True)


@effect
class Interference(Effect):
    id = "interference"
    name = "Interference"
    category = "Geometry"
    params = (_speed(), _palette("Ice"), Param("rings", "Rings", "range", 3.0, 1.0, 8.0, 0.1))

    def render(self, ctx):
        c = self.clock * 0.35
        a = _unit(np.array([math.sin(c), math.cos(c * 0.7), math.sin(c * 0.4)]))
        b = _unit(np.array([math.cos(c * 0.9), math.sin(c * 1.2), math.cos(c * 0.5)]))
        wave = np.sin(_angle(ctx.pos, a) * self.p["rings"] * 2 - self.clock * 2) + np.sin(_angle(ctx.pos, b) * self.p["rings"] * 2 - self.clock * 2)
        return palettes.sample(self.p["palette"], wave * 0.25 + 0.5)


@effect
class Facets(Effect):
    """The 20 icosahedron faces, the way the lamp is actually built."""

    id = "facets"
    name = "Polygon Dance"
    category = "Geometry"
    params = (_speed(), _palette("Neon"), Param("hold", "Hold", "range", 0.7, 0.1, 3.0, 0.05))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.colors = rng.uniform(0, 1, 20)
        self.levels = rng.uniform(0, 1, 20)
        self.next = 0.0

    def render(self, ctx):
        if self.clock > self.next:
            pick = int(self.rng.integers(20))
            self.colors[pick] = float(self.rng.random())
            self.levels[pick] = 1.0
            self.next = self.clock + float(self.p["hold"]) * 0.25
        self.levels = self.levels * math.exp(-ctx.dt * self.p["speed"] / max(self.p["hold"], 0.1))
        tone = palettes.sample(self.p["palette"], self.colors[self.geo.parent], wrap=True)
        return tone * (0.08 + 0.92 * self.levels[self.geo.parent])[:, None]


@effect
class Pentagons(Effect):
    """Blooms from the 12 five-way corners of the icosahedron."""

    id = "pentagons"
    name = "Pentagon Bloom"
    category = "Geometry"
    params = (_speed(), _palette("Sunset"))

    def render(self, ctx):
        out = np.zeros(LED_COUNT)
        for i, vertex in enumerate(self.geo.main_vertices):
            pulse = 0.5 + 0.5 * math.sin(self.clock * 1.4 + i * 1.7)
            out = np.maximum(out, pulse * (1 - _smooth(0.2, 0.75, _angle(self.geo.pos, vertex))))
        return palettes.sample(self.p["palette"], out)


@effect
class Life(Effect):
    """Cellular automaton on the real triangle graph, three neighbors each."""

    id = "life"
    name = "Life on a Sphere"
    category = "Geometry"
    params = (_speed(), _palette("Toxic"))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.alive = rng.random(LED_COUNT) < 0.35
        self.glow = np.zeros(LED_COUNT)
        self.next = 0.0
        self.seen: list[bytes] = []

    def render(self, ctx):
        if self.clock > self.next:
            self.next = self.clock + 0.35
            count = self.alive[self.geo.neighbors].sum(axis=1)
            self.alive = (self.alive & (count == 1)) | (~self.alive & (count >= 2) & (self.rng.random(LED_COUNT) < 0.5))
            sig = self.alive.tobytes()
            if not self.alive.any() or sig in self.seen:
                self.alive = self.rng.random(LED_COUNT) < 0.35
                self.seen = []
            self.seen = (self.seen + [sig])[-8:]
        self.glow += (self.alive.astype(float) - self.glow) * min(1.0, ctx.dt * 6)
        return palettes.sample(self.p["palette"], self.glow * 0.9) * self.glow[:, None]


@effect
class Snake(_Trail):
    id = "snake"
    name = "Snake"
    category = "Geometry"
    params = (_speed(1.5), _palette("Neon"), Param("length", "Length", "range", 10, 3, 40, 1))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.path = [0]
        self.next = 0.0
        self.hue = 0.0

    def render(self, ctx):
        if self.clock > self.next:
            self.next = self.clock + 0.11
            options = [int(n) for n in self.geo.neighbors[self.path[-1]] if int(n) not in self.path]
            step = int(self.rng.choice(options)) if options else int(self.rng.integers(LED_COUNT))
            self.path.append(step)
            self.path = self.path[-int(self.p["length"]) :]
            self.hue += 0.012
        out = np.zeros((LED_COUNT, 3))
        for i, led in enumerate(self.path):
            k = (i + 1) / len(self.path)
            out[led] = palettes.sample(self.p["palette"], np.array([self.hue + k * 0.2]), wrap=True)[0] * k * k
        return out


@effect
class Ripple(Effect):
    id = "ripple"
    name = "Raindrops"
    category = "Geometry"
    params = (_speed(), _palette("Ocean"), Param("rate", "Rate", "range", 1.0, 0.1, 5.0, 0.05))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.drops: list[tuple[np.ndarray, float]] = []
        self.next = 0.0

    def render(self, ctx):
        if self.clock > self.next:
            self.drops.append((_unit(self.rng.normal(size=3)), self.clock))
            self.next = self.clock + float(self.rng.exponential(1 / self.p["rate"]))
        self.drops = [d for d in self.drops if self.clock - d[1] < 2.2][-10:]
        total = np.zeros(LED_COUNT)
        for origin, born in self.drops:
            age = self.clock - born
            total += np.exp(-(((_angle(ctx.pos, origin) - age * 1.6) / 0.28) ** 2)) * (1 - age / 2.2)
        return palettes.sample(self.p["palette"], 0.1 + total * 0.85)


@effect
class Disco(Effect):
    id = "disco"
    name = "Disco Ball"
    category = "Geometry"
    params = (_speed(), Param("spots", "Spots", "range", 6, 1, 12, 1), Param("tint", "Base", "color", "#0a0a12"))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.colors = rng.uniform(0, 1, 12)
        self.offsets = rng.uniform(0, 100, (12, 2))

    def render(self, ctx):
        out = np.tile(palettes.color(self.p["tint"]), (LED_COUNT, 1))
        for i in range(int(self.p["spots"])):
            a, b = self.offsets[i]
            head = _dir(50 * math.sin(self.clock * 0.3 + a), self.clock * 40 + b * 3.6)
            lit = 1 - _smooth(0.2, 0.5, _angle(ctx.pos, head))
            out = np.maximum(out, palettes.sample("Rainbow", np.array([self.colors[i]]), wrap=True)[0] * lit[:, None])
        return out


# --- Music -------------------------------------------------------------------


@effect
class Spectrum(Effect):
    id = "spectrum"
    name = "Spectrum Globe"
    category = "Music"
    params = (_palette("Rainbow"), Param("gain", "Gain", "range", 1.0, 0.2, 3.0, 0.05))

    def render(self, ctx):
        height = (ctx.pos[:, 2] + 1) / 2 * 15
        low = np.floor(height).astype(int).clip(0, 14)
        frac = height - low
        value = ctx.audio.bins[low] * (1 - frac) + ctx.audio.bins[low + 1] * frac
        return palettes.sample(self.p["palette"], height / 15 * 0.85) * np.clip(value * self.p["gain"], 0.03, 1)[:, None]


@effect
class EqPillars(Effect):
    id = "eq_pillars"
    name = "Equalizer Crown"
    category = "Music"
    params = (_palette("Neon"), Param("gain", "Gain", "range", 1.0, 0.2, 3.0, 0.05))

    def render(self, ctx):
        index = (((ctx.lon + math.pi) / (2 * math.pi) * 16).astype(int)) % 16
        level = np.clip(ctx.audio.bins[index] * self.p["gain"], 0, 1)
        up = (ctx.pos[:, 2] + 1) / 2
        on = _smooth(0, 0.15, level - up + 0.05)
        return palettes.sample(self.p["palette"], up) * (on * 0.97 + 0.03)[:, None]


@effect
class BeatRipple(Effect):
    id = "beat_ripple"
    name = "Beat Shockwave"
    category = "Music"
    params = (_palette("Sunset"), Param("speed", "Wave speed", "range", 2.2, 0.5, 5.0, 0.05))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.waves: list[tuple[np.ndarray, float]] = []
        self.armed = True

    def render(self, ctx):
        if ctx.audio.beat > 0.8 and self.armed:
            self.waves.append((_unit(self.rng.normal(size=3)), ctx.t))
            self.armed = False
        if ctx.audio.beat < 0.5:
            self.armed = True
        self.waves = [w for w in self.waves if ctx.t - w[1] < 1.6][-6:]
        total = np.full(LED_COUNT, ctx.audio.level * 0.12)
        for origin, born in self.waves:
            age = ctx.t - born
            total += np.exp(-(((_angle(ctx.pos, origin) - age * self.p["speed"]) / 0.35) ** 2)) * (1 - age / 1.6)
        return palettes.sample(self.p["palette"], np.clip(total, 0, 1))


@effect
class Core(Effect):
    id = "core"
    name = "Reactor Core"
    category = "Music"
    params = (_palette("Ember"), Param("gain", "Gain", "range", 1.0, 0.2, 3.0, 0.05))

    def render(self, ctx):
        spin = ctx.t * (0.4 + ctx.audio.mid)
        n = fbm(ctx.pos * 2.0 + spin * 0.4, 2)
        energy = np.clip(ctx.audio.bass * self.p["gain"] * 0.9 + ctx.audio.beat * 0.25 + n * 0.25 + 0.08, 0, 1)
        out = palettes.sample(self.p["palette"], energy)
        sparks = self.rng.random(LED_COUNT) < ctx.audio.treble * 0.14
        out[sparks] = 1.0
        return out


# --- Data --------------------------------------------------------------------


@effect
class Clock(Effect):
    id = "clock"
    name = "Globe Clock"
    category = "Data"
    params = (_facing(), Param("hour", "Hour", "color", "#ff7a18"), Param("minute", "Minute", "color", "#19c8ff"), Param("second", "Second", "color", "#ffffff"), Param("base", "Base", "color", "#141a2c"))

    def render(self, ctx):
        now = ctx.now
        hour = (now.hour % 12 + now.minute / 60) / 12
        minute = (now.minute + now.second / 60) / 60
        second = (now.second + now.microsecond / 1e6) / 60
        offset = float(self.p["facing"])
        out = np.tile(palettes.color(self.p["base"]), (LED_COUNT, 1))
        for frac, lat, width, key in ((second, -50, 0.3, "second"), (minute, 8, 0.42, "minute"), (hour, 55, 0.55, "hour")):
            head = _dir(lat, offset - frac * 360)
            lit = 1 - _smooth(width * 0.4, width, _angle(ctx.pos, head))
            out = np.maximum(out, palettes.color(self.p[key]) * lit[:, None])
        return out


@effect
class Gauge(Effect):
    """Fills the sphere like a tank from any Home Assistant number."""

    id = "gauge"
    name = "Tank Gauge"
    category = "Data"
    params = (
        Param("entity", "Sensor", "entity", ""),
        Param("low", "Empty at", "range", 0.0, -1000.0, 10000.0, 1.0),
        Param("high", "Full at", "range", 100.0, -1000.0, 10000.0, 1.0),
        Param("value", "Level with no sensor", "range", 0.6, 0.0, 1.0, 0.01),
        _palette("Toxic"),
        Param("slosh", "Slosh", "range", 0.5, 0.0, 1.0, 0.01),
    )

    def render(self, ctx):
        level = float(self.p["value"])
        state = ctx.state_of(self.p["entity"]) if self.p["entity"] else None
        if state:
            try:
                span = self.p["high"] - self.p["low"]
                level = (float(state[0]) - self.p["low"]) / (span or 1.0)
            except ValueError:
                pass
        level = max(0.0, min(1.0, level))
        tilt = math.sin(ctx.t * 1.3) * ctx.pos[:, 0] * 0.1 * self.p["slosh"] + math.cos(ctx.t * 0.9) * ctx.pos[:, 1] * 0.1 * self.p["slosh"]
        surface = level * 2 - 1
        fill = 1 - _smooth(-0.1, 0.1, ctx.pos[:, 2] + tilt - surface)
        tone = palettes.sample(self.p["palette"], np.array([level]))[0]
        return tone * fill[:, None] + np.array([0.012, 0.012, 0.02]) * (1 - fill)[:, None]


_WEATHER = {
    "sunny": "sun", "clear-night": "stars", "partlycloudy": "cloud", "cloudy": "cloud",
    "fog": "fog", "rainy": "rain", "pouring": "rain", "lightning": "storm",
    "lightning-rainy": "storm", "snowy": "snow", "snowy-rainy": "snow", "windy": "cloud", "hail": "snow",
}


@effect
class Weather(Effect):
    """Shows the sky outside from a Home Assistant weather entity."""

    id = "weather"
    name = "Weather Window"
    category = "Data"
    params = (
        Param("entity", "Weather", "entity", ""),
        Param("preview", "Sky with no entity", "choice", "sun", options=("sun", "cloud", "rain", "snow", "storm", "fog", "stars")),
    )

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.drops = rng.uniform(0, 1, LED_COUNT)
        self.flash = 0.0

    def render(self, ctx):
        kind = self.p["preview"]
        state = ctx.state_of(self.p["entity"]) if self.p["entity"] else None
        if state:
            kind = _WEATHER.get(state[0], "cloud")
        p = ctx.pos
        n = fbm(p * 2.0 + np.array([ctx.t * 0.08, 0, 0]), 3)
        if kind == "sun":
            sky = np.array([0.1, 0.38, 0.95])[None, :] * (0.55 + 0.45 * (p[:, 2:3] + 1) / 2)
            sun = 1 - _smooth(0.25, 0.7, _angle(p, _dir(45, ctx.t * 6)))
            return sky * (1 - sun[:, None]) + np.array([1.0, 0.9, 0.5]) * sun[:, None]
        if kind == "stars":
            twinkle = (self.rng.random(LED_COUNT) < 0.1) * 0.5
            return np.array([0.005, 0.01, 0.05]) + twinkle[:, None]
        cover = _smooth(-0.3, 0.3, n)[:, None]
        if kind in ("fog", "cloud"):
            grey = np.array([0.42, 0.45, 0.5]) if kind == "cloud" else np.array([0.28, 0.3, 0.3])
            blue = np.array([0.1, 0.28, 0.6]) if kind == "cloud" else grey * 0.7
            return grey * cover + blue * (1 - cover)
        base = np.array([0.03, 0.05, 0.1]) + cover * 0.08
        self.drops = (self.drops + ctx.dt * (0.6 if kind == "snow" else 2.0)) % 1.0
        streak = np.exp(-(((self.drops - (1 - (p[:, 2] + 1) / 2)) * (6 if kind == "snow" else 9)) ** 2))
        tint = np.array([0.8, 0.85, 1.0]) if kind == "snow" else np.array([0.2, 0.5, 1.0])
        out = base + streak[:, None] * tint * 0.8
        if kind == "storm":
            if self.rng.random() < ctx.dt * 0.4:
                self.flash = 1.0
            self.flash *= math.exp(-ctx.dt * 7)
            out = out + self.flash
        return out


@effect
class Picture(Effect):
    """Wraps a world-map style image around the sphere."""

    id = "picture"
    name = "Picture Wrap"
    category = "Data"
    params = (Param("spin", "Spin", "range", 0.5, -6.0, 6.0, 0.05), Param("source", "Image path or URL", "text", ""))

    def __init__(self, geo, rng) -> None:
        super().__init__(geo, rng)
        self.image: np.ndarray | None = None
        self.turn = 0.0

    def render(self, ctx):
        self.turn += ctx.dt * self.p["spin"] * 0.3
        if self.image is None:
            return np.tile(np.array([0.05, 0.05, 0.07]), (LED_COUNT, 1))
        height, width = self.image.shape[:2]
        u = ((ctx.lon + self.turn) / (2 * math.pi) + 0.5) % 1.0
        v = 0.5 - ctx.lat / math.pi
        return self.image[np.minimum((v * height).astype(int), height - 1), np.minimum((u * width).astype(int), width - 1)]


# --- Basics ------------------------------------------------------------------


@effect
class Solid(Effect):
    id = "solid"
    name = "Solid"
    category = "Basics"
    params = (Param("color", "Color", "color", "#ff7a18"),)

    def render(self, ctx):
        return np.tile(palettes.color(self.p["color"]), (LED_COUNT, 1))


@effect
class Gradient(Effect):
    id = "gradient"
    name = "Pole to Pole"
    category = "Basics"
    params = (Param("top", "Top", "color", "#ff4d6d"), Param("bottom", "Bottom", "color", "#2b2bff"), _speed(0.0))

    def render(self, ctx):
        k = ((ctx.pos[:, 2] + 1) / 2)[:, None]
        wobble = np.sin(self.clock + ctx.lon)[:, None] * 0.08
        k = np.clip(k + wobble, 0, 1)
        return palettes.color(self.p["top"]) * k + palettes.color(self.p["bottom"]) * (1 - k)


@effect
class Calibrate(Effect):
    """Red top, green toward the front, blue to the right. Used to line up the model."""

    id = "calibrate"
    name = "Line Up"
    category = "Basics"

    def render(self, ctx):
        out = np.full((LED_COUNT, 3), 0.015)
        out[ctx.pos[:, 2] > 0.75] = (1, 0, 0)
        out[(ctx.pos[:, 0] > 0.75)] = (0, 1, 0)
        out[(ctx.pos[:, 1] > 0.75)] = (0, 0, 1)
        return out
