"""Listens to the lamp's own microphone through WLED's AudioReactive sound sync."""
from __future__ import annotations

import asyncio
import socket
import struct

import numpy as np

from .effects import Audio

MCAST_GROUP = "239.0.0.1"
AUDIO_PORT = 11988
SILENCE_AFTER = 1.0

# char[6] header, uint8[2] pressure, float raw, float smooth, uint8 peak, uint8 frame,
# uint8[16] fft, uint16 zero crossings, float magnitude, float major peak.
_V2 = struct.Struct("<6s2BffBB16BHff")


def parse_packet(data: bytes) -> tuple[float, int, np.ndarray] | None:
    """Return (smoothed level, peak flag, 16 FFT bins) from a V2 sync packet."""
    if len(data) < _V2.size or not data.startswith(b"00002"):
        return None
    fields = _V2.unpack(data[: _V2.size])
    return float(fields[4]), int(fields[5]), np.array(fields[7:23], dtype=float) / 255.0


class AudioState:
    """Shapes raw packets into values that animate well."""

    def __init__(self, audio: Audio) -> None:
        self.audio = audio
        self.last_packet = -999.0
        self.bass_avg = 0.0

    def feed(self, data: bytes, now: float) -> bool:
        parsed = parse_packet(data)
        if parsed is None:
            return False
        level, peak, bins = parsed
        self.last_packet = now
        a = self.audio
        a.active = True
        a.bins = a.bins + (bins - a.bins) * np.where(bins > a.bins, 0.7, 0.25)
        a.level = min(1.0, level / 255.0)
        a.bass = float(a.bins[:3].mean())
        a.mid = float(a.bins[3:9].mean())
        a.treble = float(a.bins[9:].mean())
        self.bass_avg += (a.bass - self.bass_avg) * 0.04
        if peak or (a.bass > self.bass_avg * 1.45 and a.bass > 0.2):
            a.beat = 1.0
        return True

    def decay(self, dt: float, now: float) -> None:
        a = self.audio
        a.beat *= float(np.exp(-dt * 7))
        if now - self.last_packet > SILENCE_AFTER:
            a.active = False
            a.bins = a.bins * float(np.exp(-dt * 3))
            a.level = a.bass = a.mid = a.treble = 0.0


class _Protocol(asyncio.DatagramProtocol):
    def __init__(self, state: AudioState, source: str | None) -> None:
        self.state = state
        self.source = source
        self.loop = asyncio.get_running_loop()

    def datagram_received(self, data: bytes, addr) -> None:
        if self.source is None or addr[0] == self.source:
            self.state.feed(data, self.loop.time())


async def listen(state: AudioState, source: str | None) -> asyncio.DatagramTransport:
    """Join the sound sync group. source limits it to one lamp."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    sock.bind(("", AUDIO_PORT))
    group = socket.inet_aton(MCAST_GROUP) + socket.inet_aton("0.0.0.0")
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, group)
    sock.setblocking(False)
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(lambda: _Protocol(state, source), sock=sock)
    return transport
