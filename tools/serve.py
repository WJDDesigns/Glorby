"""Run the Glorby web app on this computer, find lamps for it, and answer at http://glorby.local.

    python3 tools/serve.py            # http://glorby.local (or :5180 if port 80 is taken)
    python3 tools/serve.py --port 5180 --name glorby

Browsers can't search a network themselves, so this does it for them: the app asks
/api/discover, and this looks for WLED's mDNS service and checks every address on
the local network for a lamp. Only the Python standard library is needed.
"""
from __future__ import annotations

import argparse
import functools
import ipaddress
import json
import platform
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MDNS_GROUP = "224.0.0.251"
MDNS_PORT = 5353
TYPE_A, TYPE_PTR, TYPE_ANY = 1, 12, 255


# ---------------------------------------------------------------- network basics


def local_ip() -> str:
    """The address this computer uses on the local network. Nothing is sent."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def encode_name(name: str) -> bytes:
    out = b""
    for label in name.strip(".").split("."):
        raw = label.encode()
        out += bytes([len(raw)]) + raw
    return out + b"\0"


def read_name(data: bytes, offset: int) -> tuple[str, int]:
    """Read a DNS name, following compression pointers. Returns the name and the offset after it."""
    labels, end, jumps = [], None, 0
    while True:
        length = data[offset]
        if length & 0xC0 == 0xC0:
            if end is None:
                end = offset + 2
            offset = ((length & 0x3F) << 8) | data[offset + 1]
            jumps += 1
            if jumps > 20:
                raise ValueError("name loops")
            continue
        offset += 1
        if length == 0:
            break
        labels.append(data[offset:offset + length].decode(errors="replace"))
        offset += length
    return ".".join(labels), end if end is not None else offset


def questions(data: bytes) -> list[tuple[str, int]]:
    """The questions in an mDNS query, or nothing if the packet is a response."""
    if len(data) < 12:
        return []
    _, flags, count = struct.unpack("!HHH", data[:6])
    if flags & 0x8000:
        return []
    found, offset = [], 12
    for _ in range(count):
        name, offset = read_name(data, offset)
        qtype, _ = struct.unpack("!HH", data[offset:offset + 4])
        offset += 4
        found.append((name.lower(), qtype))
    return found


# ---------------------------------------------------------------- finding lamps


def fetch_info(host: str, timeout: float = 1.5) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://{host}/json/info", timeout=timeout) as response:
            info = json.load(response)
    except (OSError, ValueError):
        return None
    return info if isinstance(info, dict) and info.get("leds") else None


def is_glorb(info: dict) -> bool:
    # The same test the Home Assistant integration uses.
    return "GLORB" in str(info.get("ver", "")).upper()


def mdns_browse(seconds: float = 2.0) -> set[str]:
    """Ask for WLED's mDNS service and collect the address of everything that answers."""
    query = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0) + encode_name("_wled._tcp.local") + struct.pack("!HH", TYPE_PTR, 1)
    found: set[str] = set()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP) as s:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        try:
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(local_ip()))
        except OSError:
            pass
        s.settimeout(0.25)
        deadline = time.monotonic() + seconds
        # Sent from a normal port, so lamps answer straight back to it (RFC 6762, 6.7).
        for _ in range(2):
            try:
                s.sendto(query, (MDNS_GROUP, MDNS_PORT))
            except OSError:
                return found
            pause = time.monotonic() + seconds / 2
            while time.monotonic() < min(pause, deadline):
                try:
                    data, (address, _) = s.recvfrom(9000)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if len(data) >= 12 and struct.unpack("!H", data[2:4])[0] & 0x8000:
                    found.add(address)
    return found


def subnet_hosts(ip: str) -> list[str]:
    """Every other address on this computer's /24, which is how nearly every home network is set up."""
    if ip.startswith("127."):
        return []
    network = ipaddress.ip_network(f"{ip}/24", strict=False)
    return [str(h) for h in network.hosts() if str(h) != ip]


def discover() -> dict:
    """Find the Glorbs on the network. Takes about three seconds."""
    ip = local_ip()
    with ThreadPoolExecutor(max_workers=96) as pool:
        browsing = pool.submit(mdns_browse)
        hosts = subnet_hosts(ip)
        swept = dict(zip(hosts, pool.map(lambda h: fetch_info(h, 1.0), hosts)))
        heard = browsing.result()
        for host in heard - set(swept):
            swept[host] = fetch_info(host)
    lamps, others, seen = [], 0, set()
    for host, info in sorted(swept.items(), key=lambda item: ipaddress.ip_address(item[0])):
        if not info:
            continue
        mac = info.get("mac") or host
        if mac in seen:
            continue
        seen.add(mac)
        if not is_glorb(info):
            others += 1
            continue
        lamps.append({
            "address": info.get("ip") or host,
            "name": info.get("name") or "Glorb",
            "mac": info.get("mac"),
            "ver": info.get("ver"),
            "mdns": host in heard,
        })
    return {"lamps": lamps, "others": others, "network": f"{ip.rsplit('.', 1)[0]}.x"}


# ---------------------------------------------------------------- the friendly name


class Responder(threading.Thread):
    """Answers mDNS questions for <name>.local with this computer's address."""

    def __init__(self, name: str, ip: str):
        super().__init__(daemon=True)
        self.host, self.ip = f"{name}.local".lower(), ip
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        self.sock.bind(("", MDNS_PORT))
        membership = socket.inet_aton(MDNS_GROUP) + socket.inet_aton(ip)
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(ip))

    def _answer(self, query_id: int, echo: bytes) -> bytes:
        # Direct replies carry a short life and no cache-flush bit, as RFC 6762 6.7 asks.
        klass, ttl = (1, 10) if echo else (0x8001, 120)
        record = encode_name(self.host) + struct.pack("!HHIH", TYPE_A, klass, ttl, 4) + socket.inet_aton(self.ip)
        questions_count = 1 if echo else 0
        return struct.pack("!HHHHHH", query_id, 0x8400, questions_count, 1, 0, 0) + echo + record

    def announce(self) -> None:
        for _ in range(2):
            self.sock.sendto(self._answer(0, b""), (MDNS_GROUP, MDNS_PORT))
            time.sleep(1)

    def run(self) -> None:
        threading.Thread(target=self.announce, daemon=True).start()
        while True:
            try:
                data, sender = self.sock.recvfrom(9000)
                asked = [q for q in questions(data) if q[0] == self.host and q[1] in (TYPE_A, TYPE_ANY)]
            except (OSError, ValueError, IndexError, struct.error):
                continue
            if not asked:
                continue
            if sender[1] != MDNS_PORT:
                # A one-shot question from an ordinary port gets a direct reply that repeats it.
                echo = encode_name(self.host) + struct.pack("!HH", TYPE_A, 1)
                self.sock.sendto(self._answer(struct.unpack("!H", data[:2])[0], echo), sender)
            else:
                self.sock.sendto(self._answer(0, b""), (MDNS_GROUP, MDNS_PORT))


def advertise(name: str, port: int, ip: str):
    """Make <name>.local point here. Uses the system's own mDNS service when there is one."""
    if platform.system() == "Darwin" and shutil.which("dns-sd"):
        return subprocess.Popen(
            ["dns-sd", "-P", "Glorby", "_http._tcp", "local", str(port), f"{name}.local", ip],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    if shutil.which("avahi-publish-address"):
        return subprocess.Popen(
            ["avahi-publish-address", "-R", f"{name}.local", ip],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    responder = Responder(name, ip)
    responder.start()
    return responder


# ---------------------------------------------------------------- the web server


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/web/")
            self.end_headers()
            return
        if path == "/api/discover":
            body = json.dumps(discover()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, format: str, *args) -> None:
        pass


def serve(port_choices: list[int]) -> tuple[ThreadingHTTPServer, int]:
    handler = functools.partial(Handler, directory=str(ROOT))
    for port in port_choices:
        try:
            return ThreadingHTTPServer(("", port), handler), port
        except OSError:
            continue
    sys.exit(f"Couldn't use port {', '.join(map(str, port_choices))}. Pick another with --port.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, help="port to serve on (default: 80, else 5180)")
    parser.add_argument("--name", default="glorby", help="friendly name, reached as <name>.local (default: glorby)")
    parser.add_argument("--no-name", action="store_true", help="don't advertise the friendly name")
    parser.add_argument("--discover", action="store_true", help="just list the lamps found, then exit")
    args = parser.parse_args()

    if args.discover:
        print(json.dumps(discover(), indent=2))
        return

    server, port = serve([args.port] if args.port else [80, 5180])
    ip = local_ip()
    suffix = "" if port == 80 else f":{port}"
    advertiser = None
    if not args.no_name:
        try:
            advertiser = advertise(args.name, port, ip)
        except OSError as err:
            print(f"Couldn't advertise {args.name}.local ({err}). Use the address below instead.")
    print("Glorby is running. Open it on any device on this network:")
    if advertiser:
        print(f"  http://{args.name}.local{suffix}")
    print(f"  http://{ip}{suffix}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if isinstance(advertiser, subprocess.Popen):
            advertiser.terminate()


if __name__ == "__main__":
    main()
