"""Gradient palettes, sampled into 256-entry tables of floats."""
from __future__ import annotations

import numpy as np

_STOPS: dict[str, list[str]] = {
    "Aurora": ["#031a2b", "#0b6e4f", "#21d59b", "#7cf5c6", "#7b3fe4", "#150a3a"],
    "Ember": ["#000000", "#3a0500", "#a31400", "#ff5a00", "#ffb300", "#fff2b0"],
    "Ocean": ["#00061a", "#002a5c", "#00639b", "#00a6c7", "#6fe7dd", "#e6fffa"],
    "Sunset": ["#1b0b3b", "#5a1a77", "#c2185b", "#ff5e3a", "#ffb347", "#ffe29f"],
    "Neon": ["#ff00a8", "#7a00ff", "#00c8ff", "#00ffb3", "#fff000", "#ff00a8"],
    "Rainbow": ["#ff0000", "#ffb000", "#b0ff00", "#00ff40", "#00ffff", "#0040ff", "#b000ff", "#ff0000"],
    "Ice": ["#000814", "#023e8a", "#0096c7", "#90e0ef", "#ffffff"],
    "Forest": ["#02120a", "#0b3d20", "#2d6a4f", "#74c69d", "#d8f3dc"],
    "Lava": ["#000000", "#240000", "#8a0000", "#ff2a00", "#ff9500", "#ffe600"],
    "Vaporwave": ["#2d00f7", "#8900f2", "#e500a4", "#ff5c8a", "#00e5ff", "#2d00f7"],
    "Royal": ["#07041f", "#2a0a6b", "#6a1fd0", "#d4a017", "#fff0b3"],
    "Candy": ["#ff5fa2", "#ffd166", "#7cf29c", "#6ecbff", "#c58bff", "#ff5fa2"],
    "Mono": ["#000000", "#ffffff"],
    "Blood": ["#000000", "#300000", "#b00000", "#ff1a1a"],
    "Toxic": ["#001200", "#00471b", "#39d353", "#c6ff00", "#f4ffb0"],
    "Halloween": ["#120016", "#4b0082", "#ff6a00", "#ffae00", "#3dff00"],
}


def _hex(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array([int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4)])


def color(value: str) -> np.ndarray:
    """Turn '#rrggbb' into floats."""
    return _hex(value)


def _table(stops: list[str]) -> np.ndarray:
    colors = np.array([_hex(s) for s in stops])
    x = np.linspace(0, 1, len(colors))
    t = np.linspace(0, 1, 256)
    return np.stack([np.interp(t, x, colors[:, c]) for c in range(3)], axis=1)


_TABLES = {name: _table(stops) for name, stops in _STOPS.items()}
NAMES = list(_STOPS)


def stops() -> dict[str, list[str]]:
    return dict(_STOPS)


def sample(name: str, t: np.ndarray, *, wrap: bool = False) -> np.ndarray:
    """Look t (0..1) up in a palette, returning (..., 3)."""
    table = _TABLES.get(name, _TABLES["Aurora"])
    t = np.asarray(t, dtype=float)
    t = t % 1.0 if wrap else np.clip(t, 0.0, 1.0)
    pos = t * 255.0
    low = np.floor(pos).astype(int)
    high = np.minimum(low + 1, 255)
    frac = (pos - low)[..., None]
    return table[low] * (1 - frac) + table[high] * frac
