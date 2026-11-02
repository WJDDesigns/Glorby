import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / "custom_components" / "glorb"))

from core.geometry import CELLS, LED_COUNT, LEDMAP, build  # noqa: E402


def test_shape():
    g = build()
    assert g.pos.shape == (LED_COUNT, 3)
    assert len(LEDMAP) == CELLS
    assert sorted(g.cells.tolist()) == [i for i, v in enumerate(LEDMAP) if v >= 0]
    assert np.allclose(np.linalg.norm(g.pos, axis=1), 1)


def test_chain_order_follows_ledmap():
    g = build()
    numbers = [LEDMAP[c] for c in g.cells]
    assert numbers == sorted(numbers)


def test_every_face_has_three_neighbors():
    g = build()
    assert g.neighbors.shape == (LED_COUNT, 3)
    for i, ns in enumerate(g.neighbors):
        for n in ns:
            assert i in g.neighbors[n]


def test_wiring_chain_walks_across_shared_edges():
    """The LEDs are wired one triangle to the next, so every link shares an edge.

    This is what proves the matrix assignment matches the real lamp.
    """
    g = build()
    for i in range(LED_COUNT - 1):
        assert i + 1 in g.neighbors[i]


def test_upside_down_is_a_half_turn_not_a_mirror_image():
    """A real lamp can only be turned over, so handedness must survive."""
    plain, flipped = build(), build(flip=True)
    tri = plain.faces[0]
    a = np.linalg.det(plain.vertices[tri])
    b = np.linalg.det(flipped.vertices[tri])
    assert np.sign(a) == np.sign(b)
    assert np.allclose(flipped.pos[:, 0], plain.pos[:, 0])
    assert np.allclose(flipped.pos[:, 2], -plain.pos[:, 2])
