"""Render every effect's front view to one image, without touching the lamp."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parents[1] / "custom_components" / "glorb"))

from core.effects import REGISTRY, Audio  # noqa: E402
from core.engine import Engine  # noqa: E402

SIZE = 170
COLS = 7


def draw(engine: Engine, rgb: bytes) -> Image.Image:
    colors = np.frombuffer(rgb, dtype=np.uint8).reshape(-1, 3)
    img = Image.new("RGB", (SIZE, SIZE), (6, 7, 10))
    d = ImageDraw.Draw(img)
    geo = engine.geo
    center = geo.vertices[geo.faces].mean(axis=1)
    for i in np.argsort(center[:, 0]):
        if center[i, 0] <= 0:
            continue
        points = [
            (SIZE / 2 + geo.vertices[v, 1] * SIZE * 0.46, SIZE / 2 - geo.vertices[v, 2] * SIZE * 0.46)
            for v in geo.faces[i]
        ]
        d.polygon(points, fill=tuple(int(c) for c in colors[i]), outline=(12, 12, 14))
    return img


def main(out: str) -> None:
    ids = list(REGISTRY)
    rows = (len(ids) + COLS - 1) // COLS
    sheet = Image.new("RGB", (COLS * (SIZE + 8), rows * (SIZE + 26)), (20, 22, 28))
    d = ImageDraw.Draw(sheet)
    for n, effect_id in enumerate(ids):
        engine = Engine(lambda _p: None)
        engine.audio = Audio(active=True, level=0.7, bass=0.8, mid=0.5, treble=0.4, beat=1.0, bins=np.linspace(0.95, 0.15, 16))
        engine.play(effect_id)
        display = b""
        for _ in range(70):
            display, _p = engine.step(1 / 30)
        x, y = (n % COLS) * (SIZE + 8) + 4, (n // COLS) * (SIZE + 26) + 4
        sheet.paste(draw(engine, display), (x, y))
        d.text((x + 4, y + SIZE + 3), REGISTRY[effect_id].name, fill=(230, 232, 238))
    sheet.save(out)


main(sys.argv[1])
