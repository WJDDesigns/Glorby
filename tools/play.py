"""Run effects on the real lamp from a terminal, without Home Assistant.

    .venv/bin/python tools/play.py 192.168.4.191 --list
    .venv/bin/python tools/play.py 192.168.4.191 eye --seconds 10
    .venv/bin/python tools/play.py 192.168.4.191 --tour 5
"""
import argparse
import asyncio
import json
import socket
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "custom_components" / "glorb"))

from core.effects import REGISTRY  # noqa: E402
from core.engine import Engine  # noqa: E402


def release(ip: str) -> None:
    req = urllib.request.Request(
        f"http://{ip}/json/state",
        data=json.dumps({"live": False}).encode(),
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=3).read()


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ip")
    ap.add_argument("effect", nargs="?")
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--tour", type=float)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--params", default="{}")
    args = ap.parse_args()
    if args.list:
        for fx in REGISTRY.values():
            print(f"{fx.category:9} {fx.id:14} {fx.name}")
        return
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    engine = Engine(lambda p: sock.sendto(p, (args.ip, 4048)))
    engine.start()
    try:
        if args.tour:
            for fx_id, fx in REGISTRY.items():
                print(fx.name)
                engine.play(fx_id)
                await asyncio.sleep(args.tour)
        else:
            engine.play(args.effect, json.loads(args.params))
            await asyncio.sleep(args.seconds)
    finally:
        await engine.stop()
        release(args.ip)
        print(engine.snapshot())


asyncio.run(main())
