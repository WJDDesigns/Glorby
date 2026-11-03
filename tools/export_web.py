"""Write the lamp's 3D model for the web app, which has no Python to build it with."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "glorb"))

from core import geometry  # noqa: E402

# A standing lamp has its first LEDs at the base, so upside down is the default.
geo = geometry.build(flip=True)
out = {
    "vertices": [[round(float(v), 5) for v in row] for row in geo.vertices],
    "faces": geo.faces.tolist(),
    "cells": geo.cells.tolist(),
}
path = ROOT / "web" / "lamp-map.json"
path.write_text(json.dumps(out, separators=(",", ":")))
print(path, path.stat().st_size, "bytes")
