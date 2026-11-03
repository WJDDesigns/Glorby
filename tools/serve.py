"""Run the Glorby web app on this computer, find lamps for it, and answer at http://glorby.local.

    python3 tools/serve.py            # http://glorby.local (or :5180 if port 80 is taken)
    python3 tools/serve.py --port 5180 --name glorby

Browsers can't search a network themselves, so this does it for them: the app asks
/api/discover, and this looks for WLED's mDNS service and checks every address on
the local network for a lamp, then the ranges next to it if nothing turned up. Only the Python standard library is needed.
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
import urllib.parse
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


def interfaces() -> dict[str, int]:
    """This computer's private IPv4 addresses and their network sizes, from its own settings."""
    found: dict[str, int] = {}
    for command in (["ip", "-o", "-4", "addr"], ["ifconfig"]):
        if not shutil.which(command[0]):
            continue
        try:
            text = subprocess.run(command, capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        for line in text.splitlines():
            words = line.split()
            if "inet" not in words or words.index("inet") + 1 >= len(words):
                continue
            address = words[words.index("inet") + 1]
            try:
                if "/" in address:
                    address, bits = address.split("/")
                    prefix = int(bits)
                elif "netmask" in words:
                    mask = words[words.index("netmask") + 1]
                    number = int(mask, 16) if mask.startswith("0x") else int(ipaddress.ip_address(mask))
                    prefix = bin(number).count("1")
                else:
                    prefix = 24
            except (ValueError, IndexError):
                continue
            if is_private(address):
                found[address] = prefix
        if found:
            break
    return found


def prefix_length(ip: str) -> int:
    """The network size this computer is set up with for ip. Assumes /24 if unsure."""
    return interfaces().get(ip, 24)


def is_private(ip: str) -> bool:
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return address.version == 4 and address.is_private and not address.is_loopback


def range_hosts(network: ipaddress.IPv4Network) -> list[str]:
    return [str(h) for h in network.hosts()]


def own_network(ip: str) -> ipaddress.IPv4Network:
    # Bigger networks are cut to the 1,022 addresses around this computer, to keep the search quick.
    return ipaddress.ip_network(f"{ip}/{max(prefix_length(ip), 22)}", strict=False)


# Ranges home routers and mesh systems hand out by default, so the deep search reaches
# lights that a router keeps apart from computers (Eero, Deco, Google, UniFi, ASUS, Fritz!Box...).
COMMON_RANGES = [
    "192.168.0", "192.168.1", "192.168.2", "192.168.3", "192.168.4", "192.168.5", "192.168.8", "192.168.10",
    "192.168.20", "192.168.30", "192.168.50", "192.168.68", "192.168.86", "192.168.88", "192.168.100",
    "192.168.178", "10.0.0", "10.0.1", "10.0.2", "10.1.1", "10.10.10", "172.16.0",
]


def nearby_networks(ip: str) -> list[ipaddress.IPv4Network]:
    """Ranges next to this one and the usual router defaults. Lights often sit apart, like 192.168.4.x beside 192.168.1.x."""
    a, b, _, _ = ip.split(".")
    ranges = [f"{a}.{b}.{c}" for c in range(16)] + COMMON_RANGES
    return [ipaddress.ip_network(f"{r}.0/24") for r in dict.fromkeys(ranges)]


KNOWN = Path.home() / ".glorby" / "lamps.json"


def known_addresses() -> list[str]:
    try:
        return [lamp["address"] for lamp in json.loads(KNOWN.read_text())]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def keep_known(lamps: list[dict]) -> None:
    """Remember where lamps were, so the next quick search looks there first."""
    if not lamps:
        return
    try:
        KNOWN.parent.mkdir(exist_ok=True)
        KNOWN.write_text(json.dumps([{"address": l["address"], "name": l["name"], "mac": l["mac"]} for l in lamps]))
    except OSError:
        pass


def discover(hints: list[str] = (), deep: bool = False) -> dict:
    """Find the Glorbs on the network.

    The quick search (about three seconds) asks mDNS and checks every network this
    computer is on, plus the ranges of any lamp seen before. The deep search (about twenty
    seconds) also checks neighbouring ranges and the usual router defaults, which finds
    lamps a router keeps on a range of their own.
    """
    # Every network this computer is on: a Mac can be on Wi-Fi and Ethernet at once.
    mine = interfaces()
    primary = local_ip()
    if is_private(primary):
        mine.setdefault(primary, 24)
    networks = [ipaddress.ip_network(f"{ip}/{max(bits, 22)}", strict=False) for ip, bits in mine.items()]
    for hint in [*hints, *known_addresses()]:
        if is_private(hint):
            networks.append(ipaddress.ip_network(f"{hint}/24", strict=False))
    if deep:
        for ip in mine:
            networks += nearby_networks(ip)
    hosts = list(dict.fromkeys(h for n in networks for h in range_hosts(n) if h not in mine))
    with ThreadPoolExecutor(max_workers=256) as pool:
        browsing = pool.submit(mdns_browse)
        swept = dict(zip(hosts, pool.map(lambda h: fetch_info(h, 0.8 if deep else 1.0), hosts)))
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
    keep_known(lamps)
    return {"lamps": lamps, "others": others, "searched": len(hosts), "deep": deep}


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
            query = urllib.parse.parse_qs(self.path.partition("?")[2])
            body = json.dumps(discover(query.get("hint", []), "deep" in query)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self) -> None:
        # Always check for a newer copy, so an update shows up on the next reload.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

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
    parser.add_argument("--deep", action="store_true", help="with --discover, also search the neighbouring ranges")
    args = parser.parse_args()

    if args.discover:
        print(json.dumps(discover(deep=args.deep), indent=2))
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
