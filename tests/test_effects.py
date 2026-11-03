import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "custom_components" / "glorb"))

from core.audio import AudioState, _V2, parse_packet  # noqa: E402
from core.effects import REGISTRY, SWEEP_DIRECTIONS, Audio, moon_phase, subsolar_point, sweep_mask  # noqa: E402
from core.engine import DDP_HEADER, Engine  # noqa: E402
from core.geometry import LEDMAP  # noqa: E402


def engine():
    return Engine(lambda _p: None)


@pytest.mark.parametrize("effect_id", sorted(REGISTRY))
def test_every_effect_renders_valid_frames(effect_id):
    e = engine()
    e.audio = Audio(active=True, level=0.6, bass=0.7, mid=0.4, treble=0.5, beat=1.0, bins=np.linspace(1, 0, 16))
    e.play(effect_id)
    for _ in range(60):
        display, packet = e.step(1 / 30)
    assert len(display) == 240
    assert len(packet) == len(DDP_HEADER) + 360
    assert max(display) >= 0


@pytest.mark.parametrize("effect_id", sorted(REGISTRY))
def test_params_clamp_and_describe(effect_id):
    fx = REGISTRY[effect_id]
    info = fx.describe()
    assert info["name"] and info["category"]
    e = engine()
    live = e.play(effect_id)
    for param in fx.params:
        if param.kind == "range":
            live.set({param.key: param.max + 99999})
            assert live.p[param.key] == param.max


def test_effects_are_not_black():
    """Effects with no audio dependency must actually draw something."""
    for effect_id, fx in REGISTRY.items():
        if fx.category in ("Music", "Data"):
            continue
        e = engine()
        e.play(effect_id)
        total = 0
        for _ in range(90):
            display, _p = e.step(1 / 30)
            total = max(total, sum(display))
        assert total > 300, effect_id


def test_matrix_falls_from_the_top_and_lights_nothing_ahead_of_it():
    e = engine()
    fx = e.play("matrix")
    fx.head[:] = 0.0
    fx.rate[:] = 1.0
    for _ in range(30):
        display, _p = e.step(1 / 30)
    colors = np.frombuffer(display, dtype=np.uint8).reshape(-1, 3)
    down = np.pi / 2 - e.geo.lat
    assert colors.sum(axis=1)[down < fx.head[0]].max() > 0
    assert colors.sum(axis=1)[down > fx.head[0]].max() == 0


def _band_height(e, passes, direction):
    mask = sweep_mask(e.geo.lat, e.geo.lon, direction, passes, 0.5)
    return float((e.geo.lat * mask).sum() / mask.sum())


def test_sweep_directions_move_the_right_way():
    e = engine()
    assert _band_height(e, 0.3, "Up") < _band_height(e, 0.7, "Up")
    assert _band_height(e, 0.3, "Down") > _band_height(e, 0.7, "Down")
    assert _band_height(e, 0.25, "Up and down") < _band_height(e, 0.75, "Up and down")
    assert _band_height(e, 1.25, "Up and down") > _band_height(e, 1.75, "Up and down")
    right = sweep_mask(e.geo.lat, e.geo.lon, "Right", 0.1, 0.5)
    assert abs(float(e.geo.lon[right.argmax()]) - 0.1 * 2 * np.pi) < 1.0
    left = sweep_mask(e.geo.lat, e.geo.lon, "Left", 0.1, 0.5)
    assert abs(float(e.geo.lon[left.argmax()]) + 0.1 * 2 * np.pi) < 1.0


@pytest.mark.parametrize("direction", SWEEP_DIRECTIONS)
def test_sweep_effect_and_alert_follow_their_settings(direction):
    e = engine()
    e.play("sweep", {"direction": direction, "color": "#ffffff", "background": "#000000"})
    lit = [sum(e.step(1 / 30)[0]) for _ in range(120)]
    assert max(lit) > 0
    e.play("solid", {"color": "#000000"}, transition=0)
    e.alert("sweep", "#ffffff", "#000000", 2.0, 1.0, direction, 2.0, 0.8)
    overlay = e.overlays[0]
    assert (overlay.direction, overlay.speed, overlay.width) == (direction, 2.0, 0.8)
    lit = [sum(e.step(1 / 30)[0]) for _ in range(30)]
    assert max(lit) > 0


def test_packet_only_writes_real_cells():
    e = engine()
    e.play("solid", {"color": "#ffffff"})
    _display, packet = e.step(0.03)
    body = packet[len(DDP_HEADER) :]
    for cell, mapped in enumerate(LEDMAP):
        lit = body[cell * 3] > 0
        assert lit == (mapped >= 0)


def test_gamma_is_applied_to_the_lamp_and_not_the_view():
    e = engine()
    e.play("solid", {"color": "#808080"})
    display, packet = e.step(0.03)
    assert display[0] == 128
    assert packet[len(DDP_HEADER)] < 40


def test_solar_and_lunar_sanity():
    lat, _lon = subsolar_point(datetime(2026, 6, 21, 12, tzinfo=timezone.utc))
    assert 23 < lat < 24
    assert abs(subsolar_point(datetime(2026, 6, 21, 12, tzinfo=timezone.utc))[1]) < 1
    # A known full moon.
    assert abs(moon_phase(datetime(2026, 1, 3, 10, tzinfo=timezone.utc)) - 0.5) < 0.04


def test_audio_packet():
    data = _V2.pack(b"00002\0", 0, 0, 1.0, 128.0, 1, 3, *range(16), 0, 5.0, 440.0)
    level, peak, bins = parse_packet(data)
    assert level == 128.0 and peak == 1
    assert bins[15] == pytest.approx(15 / 255)
    assert parse_packet(b"junk") is None
    state = AudioState(Audio())
    assert state.feed(data, 10.0)
    assert state.audio.beat == 1.0
    state.decay(0.1, 20.0)
    assert not state.audio.active


def test_render_budget():
    e = engine()
    worst = 0.0
    for effect_id in REGISTRY:
        e.play(effect_id, transition=0)
        started = time.perf_counter()
        for _ in range(20):
            e.step(1 / 40)
        worst = max(worst, (time.perf_counter() - started) / 20)
    assert worst < 0.012, f"{worst * 1000:.1f}ms"
