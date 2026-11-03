"""Write the lamp's 3D model and noise tables for the web app, which has no Python to build them with."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "glorb"))

from core import effects, geometry  # noqa: E402

# A standing lamp has its first LEDs at the base, so upside down is the default.
geo = geometry.build(flip=True)
out = {
    "vertices": [[round(float(v), 5) for v in row] for row in geo.vertices],
    "faces": geo.faces.tolist(),
    "cells": geo.cells.tolist(),
    # Which of the 20 icosahedron faces each LED is on, for effects that light whole faces.
    "parent": geo.parent.tolist(),
    # The same noise as the integration, so effects look the same in both.
    "noise": {
        "perm": effects._PERM[:256].tolist(),
        "grad": [[round(float(v), 7) for v in row] for row in effects._GRAD],
    },
}
path = ROOT / "web" / "lamp-map.json"
path.write_text(json.dumps(out, separators=(",", ":")))
print(path, path.stat().st_size, "bytes")
