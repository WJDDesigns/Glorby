"""Check the web app's effects against the integration's: same catalog, same frames.

Effects that only use time and position must match within a shade or two. Ones that
roll dice are checked for drawing something sensible, since the dice differ.
Run with `python3 tools/check_web_effects.py`. It needs Node.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "glorb"))

from core import geometry, palettes  # noqa: E402
from core.effects import CATEGORIES, REGISTRY, SWEEP_DIRECTIONS, Audio  # noqa: E402
from core.engine import OVERLAY_PATTERNS, Engine  # noqa: E402

NOW = datetime(2026, 6, 21, 15, 30, 12, tzinfo=timezone.utc)
STEPS, DT = 45, 1 / 30
AUDIO = {"active": True, "level": 0.6, "bass": 0.7, "mid": 0.4, "treble": 0.0, "beat": 0.0,
         "bins": [round(float(v), 4) for v in np.linspace(1, 0, 16)]}

# Effects that don't roll dice, with settings that keep them that way. Face is checked as Sad:
# Surprised has a mouth point exactly between two triangles, so either app may pick either.
SAME = [
    ("earth", {}), ("earth", {"real_sun": False}), ("moon", {}), ("moon", {"real_phase": False, "phase": 0.3}),
    ("sun", {}), ("jupiter", {}), ("basketball", {"tilt": 40}), ("pumpkin", {"facing": 30}),
    ("eye", {"track": False, "blink": False, "look_x": 0.4}), ("face", {"mood": "Sad"}), ("face", {"mood": "Wink"}),
    ("aurora", {}), ("nebula", {}), ("plasma", {}), ("ocean", {}), ("fire", {}),
    ("sweep", {}), ("sweep", {"direction": "Left"}), ("sweep", {"direction": "Up"}),
    ("scanner", {}), ("orbits", {"rings": 5}), ("spiral", {}), ("interference", {}), ("pentagons", {}),
    ("spectrum", {}), ("eq_pillars", {}), ("core", {}), ("clock", {"facing": 20}),
    ("gauge", {"value": 0.3}), ("weather", {"preview": "sun"}), ("weather", {"preview": "cloud"}), ("weather", {"preview": "fog"}),
    ("picture", {}), ("solid", {"color": "#336699"}), ("gradient", {"speed": 1}), ("calibrate", {}),
    ("plasma", {"__globals": {"spin": 12, "tumble": 7, "hue": 40, "saturation": 1.3, "gain": 0.8}}),
]
DICE = sorted(set(REGISTRY) - {e for e, _ in SAME})


def python_frame(effect: str, params: dict) -> np.ndarray:
    engine = Engine(lambda _p: None, geometry=geometry.build(flip=True))
    engine.audio = Audio(**{**AUDIO, "bins": np.array(AUDIO["bins"])})
    engine.set_globals(params.get("__globals", {}))
    engine.play(effect, {k: v for k, v in params.items() if k != "__globals"})
    import core.engine as engine_module

    class _Now(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

    engine_module.datetime = _Now
    for _ in range(STEPS):
        display, _packet = engine.step(DT)
    return np.frombuffer(display, dtype=np.uint8).astype(int)


def main() -> int:
    runs = [{"effect": e, "params": {k: v for k, v in p.items() if k != "__globals"}, "globals": p.get("__globals", {})}
            for e, p in SAME] + [{"effect": e} for e in DICE]
    job = {"now": NOW.isoformat(), "steps": STEPS, "dt": DT, "audio": AUDIO, "runs": runs}
    out = subprocess.run(["node", str(ROOT / "tools" / "web_frames.mjs")], input=json.dumps(job),
                         capture_output=True, text=True, check=True, env={**os.environ, "TZ": "UTC"})
    result = json.loads(out.stdout)
    problems = []

    catalog = result["catalog"]
    if catalog["categories"] != list(CATEGORIES):
        problems.append("categories differ")
    if catalog["patterns"] != list(OVERLAY_PATTERNS) or catalog["sweep_directions"] != list(SWEEP_DIRECTIONS):
        problems.append("alert patterns or sweep directions differ")
    if catalog["palettes"] != palettes.stops():
        problems.append("palettes differ")
    web = {fx["id"]: fx for fx in catalog["effects"]}
    for effect_id, fx in REGISTRY.items():
        if effect_id not in web:
            problems.append(f"{effect_id} is missing from the web app")
        elif web[effect_id] != fx.describe():
            problems.append(f"{effect_id} has different settings in the web app")
    for extra in set(web) - set(REGISTRY):
        problems.append(f"{extra} is only in the web app")

    for (effect, params), frame in zip(SAME, result["frames"]):
        diff = np.abs(np.array(frame) - python_frame(effect, params)).max()
        label = f"{effect} {params}" if params else effect
        print(f"{'ok ' if diff <= 2 else 'BAD'} {label}: largest difference {diff}")
        if diff > 2:
            problems.append(f"{label} draws differently (off by up to {diff})")
    for effect, frame in zip(DICE, result["frames"][len(SAME):]):
        lit = sum(frame)
        print(f"{'ok ' if lit > 0 else 'BAD'} {effect}: draws {lit} in total")
        if lit == 0:
            problems.append(f"{effect} draws nothing")

    print(f"\n{len(REGISTRY)} effects, {len(problems)} problems")
    for p in problems:
        print(" -", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
