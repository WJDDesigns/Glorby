"""Where each of the Glorb's 80 LEDs sits in 3D.

The lamp is a 2-frequency icosphere: 20 icosahedron faces, each split into 4
triangles, one LED per triangle. Stock firmware flattens that into a 20x6 matrix
with a ledmap, using these row sizes from the north pole down: 5, 15, 20, 20, 15, 5.

Face order is the LED's position in the firmware's ledmap, so index 0 is the
first LED in the chain. Coordinates are unit vectors with +z up.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MATRIX_W = 20
MATRIX_H = 6
CELLS = MATRIX_W * MATRIX_H
LED_COUNT = 80

# Copied from /ledmap.json on the lamp, firmware 0.14.4-GLORB.1.2.
LEDMAP = [
    1, -1, -1, -1, 2, -1, -1, -1, 3, -1, -1, -1, 4, -1, -1, -1, 5, -1, -1, -1,
    9, 10, -1, 11, 12, 13, -1, 14, 15, 16, -1, 17, 18, 19, -1, 20, 6, 7, -1, 8,
    37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 41, 40, 39, 38,
    46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 42, 43, 44, 45,
    -1, 67, 68, 69, -1, 70, 71, 72, -1, 73, 74, 75, -1, 76, 77, 63, -1, 64, 65, 66,
    -1, -1, 80, -1, -1, -1, 81, -1, -1, -1, 82, -1, -1, -1, 78, -1, -1, -1, 79, -1,
]
ROW_SIZES = (5, 15, 20, 20, 15, 5)


def _icosahedron() -> tuple[np.ndarray, list[tuple[int, int, int]]]:
    lat = np.arctan(0.5)
    verts = [(0.0, 0.0, 1.0)]
    for i in range(5):
        a = np.radians(72 * i)
        verts.append((np.cos(lat) * np.cos(a), np.cos(lat) * np.sin(a), np.sin(lat)))
    for i in range(5):
        a = np.radians(36 + 72 * i)
        verts.append((np.cos(lat) * np.cos(a), np.cos(lat) * np.sin(a), -np.sin(lat)))
    verts.append((0.0, 0.0, -1.0))
    faces = []
    for i in range(5):
        j = (i + 1) % 5
        up_i, up_j, lo_i, lo_j = 1 + i, 1 + j, 6 + i, 6 + j
        faces.append((0, up_i, up_j))
        faces.append((up_i, lo_i, up_j))
        faces.append((up_j, lo_i, lo_j))
        faces.append((11, lo_j, lo_i))
    return np.array(verts), faces


def _subdivide(verts: np.ndarray, faces: list[tuple[int, int, int]]):
    points = [tuple(v) for v in verts]
    mids: dict[tuple[int, int], int] = {}

    def midpoint(a: int, b: int) -> int:
        key = (min(a, b), max(a, b))
        if key not in mids:
            m = np.array(points[a]) + np.array(points[b])
            points.append(tuple(m / np.linalg.norm(m)))
            mids[key] = len(points) - 1
        return mids[key]

    out = []
    parents = []
    corners = []
    for parent, (a, b, c) in enumerate(faces):
        ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
        for tri, corner in (
            ((a, ab, ca), a),
            ((b, bc, ab), b),
            ((c, ca, bc), c),
            ((ab, bc, ca), -1),
        ):
            out.append(tri)
            parents.append(parent)
            corners.append(corner)
    return np.array(points), out, parents, corners


@dataclass(frozen=True)
class Geometry:
    """All per-LED lookups, indexed by LED."""

    vertices: np.ndarray  # (42, 3)
    faces: np.ndarray  # (80, 3) vertex indices
    pos: np.ndarray  # (80, 3) unit vectors at each triangle's center
    lat: np.ndarray  # (80,) radians
    lon: np.ndarray  # (80,) radians
    neighbors: np.ndarray  # (80, 3) LEDs sharing an edge
    parent: np.ndarray  # (80,) which of the 20 icosahedron faces
    corner: np.ndarray  # (80,) which of the 12 main vertices, -1 for center triangles
    cells: np.ndarray  # (80,) index into the 120-cell matrix
    main_vertices: np.ndarray  # (12, 3)


def _assign_rows(pos: np.ndarray, faces: list) -> list[list[int]]:
    """Group faces into the matrix's six rows, which are latitude bands."""
    order = np.argsort(-pos[:, 2])
    rows = []
    start = 0
    for size in ROW_SIZES:
        rows.append(list(order[start : start + size]))
        start += size
    return rows


def build(
    *, mirror: bool = False, flip: bool = False, rotation_deg: float = 0.0
) -> Geometry:
    """Build the lookups.

    mirror, flip and rotation_deg correct for how the lamp is actually built and
    mounted. They change where a face is drawn and lit, never which LED it is.
    """
    base_v, base_f = _icosahedron()
    verts, faces, parents, corners = _subdivide(base_v, base_f)
    tri = np.array(faces)
    centers = verts[tri].mean(axis=1)
    centers /= np.linalg.norm(centers, axis=1, keepdims=True)

    rows = _assign_rows(centers, faces)
    logical = np.array(LEDMAP)
    cell_of_face = np.full(LED_COUNT, -1)
    for row, members in enumerate(rows):
        xs = [x for x in range(MATRIX_W) if logical[row * MATRIX_W + x] >= 0]
        # x=0 on the top row is the tip centered on longitude 36.
        want = [(36.0 + 18.0 * x) % 360.0 for x in xs]
        lons = np.degrees(np.arctan2(centers[members, 1], centers[members, 0])) % 360.0
        members_sorted = [members[i] for i in np.argsort(lons)]
        lons_sorted = np.sort(lons)
        best, best_err = 0, 1e12
        for shift in range(len(xs)):
            d = (np.roll(lons_sorted, shift) - np.array(want) + 180.0) % 360.0 - 180.0
            err = float(np.abs(d).sum())
            if err < best_err:
                best, best_err = shift, err
        for x, member in zip(xs, np.roll(np.array(members_sorted), best)):
            cell_of_face[member] = row * MATRIX_W + x

    # Reorder faces into LED chain order.
    chain_order = np.argsort([logical[c] for c in cell_of_face])
    tri = tri[chain_order]
    cells = cell_of_face[chain_order]
    parent = np.array(parents)[chain_order]
    corner_raw = np.array(corners)[chain_order]
    corner = np.where(corner_raw >= 0, corner_raw, -1)

    if rotation_deg or mirror or flip:
        a = np.radians(rotation_deg)
        rot = np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]])
        verts = verts @ rot.T
        if mirror:
            verts = verts * np.array([1, -1, 1])
        if flip:
            # A half turn, not a reflection: the lamp is the same object upside down.
            verts = verts * np.array([1, -1, -1])

    pos = verts[tri].mean(axis=1)
    pos /= np.linalg.norm(pos, axis=1, keepdims=True)

    neighbors = np.zeros((LED_COUNT, 3), dtype=int)
    for i in range(LED_COUNT):
        shared = [
            j
            for j in range(LED_COUNT)
            if j != i and len(set(tri[i]) & set(tri[j])) == 2
        ]
        neighbors[i] = shared

    return Geometry(
        vertices=verts,
        faces=tri,
        pos=pos,
        lat=np.arcsin(np.clip(pos[:, 2], -1, 1)),
        lon=np.arctan2(pos[:, 1], pos[:, 0]),
        neighbors=neighbors,
        parent=parent,
        corner=corner,
        cells=cells,
        main_vertices=verts[:12],
    )
