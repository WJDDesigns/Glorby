"""Find the frame rate the lamp can sustain, stopping the moment it struggles.

    .venv/bin/python tools/soak.py 192.168.4.191 --rates 10,15,20,25,30 --seconds 30
"""
import argparse
import asyncio
import json
import socket
import sys
import time
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).parents[1] / "custom_components" / "glorb"))

from core.engine import Engine  # noqa: E402

MAX_MISSES = 2


async def health(session: aiohttp.ClientSession, ip: str) -> dict | None:
    started = time.perf_counter()
    try:
        async with session.get(f"http://{ip}/json/info", timeout=aiohttp.ClientTimeout(total=2)) as resp:
            info = await resp.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return None
    return {
        "ms": round((time.perf_counter() - started) * 1000),
        "heap": info["freeheap"],
        "uptime": info["uptime"],
        "live": info["live"],
        "fps": info["leds"]["fps"],
    }


async def release(session: aiohttp.ClientSession, ip: str) -> bool:
    try:
        async with session.post(
            f"http://{ip}/json/state", data=json.dumps({"live": False}), timeout=aiohttp.ClientTimeout(total=3)
        ):
            return True
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return False


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ip")
    ap.add_argument("--rates", default="10,15,20,25,30")
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--effect", default="eye")
    ap.add_argument("--check-every", type=float, default=3)
    args = ap.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    async with aiohttp.ClientSession() as session:
        first = await health(session, args.ip)
        print("before:", first)
        if first is None:
            return 2
        boot_uptime = first["uptime"]
        for rate in (int(r) for r in args.rates.split(",")):
            engine = Engine(lambda p: sock.sendto(p, (args.ip, 4048)), fps=rate)
            engine.play(args.effect)
            engine.start()
            samples = []
            misses = 0
            ended = time.monotonic() + args.seconds
            while time.monotonic() < ended and misses < MAX_MISSES:
                await asyncio.sleep(args.check_every)
                sample = await health(session, args.ip)
                if sample is None:
                    misses += 1
                else:
                    misses = 0
                    samples.append(sample)
                    if sample["uptime"] < boot_uptime:
                        print(f"{rate} fps: LAMP REBOOTED, uptime {sample['uptime']}")
                        misses = MAX_MISSES
                        break
                    boot_uptime = sample["uptime"]
            await engine.stop()
            if misses >= MAX_MISSES:
                print(f"{rate} fps: FAILED after {len(samples)} good checks, sent at {engine.actual_fps:.1f} fps")
                return 1
            ms = [s["ms"] for s in samples]
            print(
                f"{rate} fps: ok, sent about {engine.actual_fps:.1f}, lamp {samples[-1]['fps']} fps, "
                f"http {min(ms)}-{max(ms)} ms, heap {min(s['heap'] for s in samples)}"
            )
        print("released:", await release(session, args.ip))
        await asyncio.sleep(1)
        print("after:", await health(session, args.ip))
    return 0


sys.exit(asyncio.run(main()))
