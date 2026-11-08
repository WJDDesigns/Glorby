// Finds Glorbs on the local network so nobody has to look up an address.
//
// Browsers can't search a network, so there are two ways in:
// 1. When Glorby's helper (tools/serve.py) serves the page, it searches with mDNS
//    and a sweep of the network, and answers /api/discover.
// 2. Otherwise the page asks likely addresses for WLED's /json/info itself. It can't
//    learn its own network, so it starts with addresses it knows of and then
//    tries the ranges most home routers use. Slower, but needs nothing installed.

const PROBE_MS = 1500;
const AT_ONCE = 96;
// The ranges home routers hand out most often, most common first.
const COMMON = ["192.168.1", "192.168.0", "10.0.0", "192.168.86", "192.168.68", "10.0.1", "192.168.2", "192.168.50"];
const NAMES = ["glorb.local", "wled.local"];

/**
 * True for a Glorb, on any firmware: the vendor's (its version says GLORB), Glorby's own
 * build (it reports a network watchdog, netwd, and a GLORB release name), or plain WLED
 * set up like a Glorb (80 faces, or the stock 20 x 6 matrix of 120). The same test as
 * tools/serve.py and the Home Assistant integration.
 */
export function isGlorb(info) {
  if (!info?.leds) return false;
  if (/GLORB/i.test(`${info.ver ?? ""} ${info.release ?? ""}`) || info.netwd !== undefined) return true;
  const { count, matrix } = info.leds;
  return count === 80 || (count === 120 && matrix?.w === 20 && matrix?.h === 6);
}

function prefix(host) {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(host || "");
  if (!m) return null;
  const [a, b] = m[1].split(".").map(Number);
  // Only private ranges, since lamps live on home networks.
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b < 32) ? m[1] : null;
}

function hostOf(address) {
  try {
    return new URL(/^https?:\/\//.test(address) ? address : `http://${address}`).hostname;
  } catch {
    return "";
  }
}

async function getJson(url, ms, signal) {
  const timer = new AbortController();
  const stop = () => timer.abort();
  const clock = setTimeout(stop, ms);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const response = await fetch(url, { signal: timer.signal, cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(clock);
    signal?.removeEventListener("abort", stop);
  }
}

/** Asks the helper that served this page, if there is one. Returns null when there isn't. */
async function askHelper(hints, deep, signal) {
  const url = new URL("/api/discover", location.href);
  hints.forEach((hint) => url.searchParams.append("hint", hint));
  if (deep) url.searchParams.set("deep", "1");
  const result = await getJson(url, deep ? 45000 : 15000, signal);
  return Array.isArray(result?.lamps) ? result : null;
}

/**
 * Looks for Glorbs and reports each one as soon as it answers.
 *
 * hints: addresses already known (saved lamps, Home Assistant), checked first and
 * used to guess the network. onLamp({address, name, mac, ver}) fires once per lamp.
 * onProgress(text) describes what's being checked. Resolves with every lamp found.
 */
export async function findLamps({ hints = [], onLamp = () => {}, onProgress = () => {}, signal } = {}) {
  const found = new Map();
  const report = (lamp) => {
    const key = lamp.mac || lamp.address;
    if (found.has(key) || signal?.aborted) return;
    found.set(key, lamp);
    onLamp(lamp);
  };

  onProgress("Asking the network");
  const hintHosts = [location.hostname, ...hints.map(hostOf)].filter(Boolean);
  let helper = await askHelper(hintHosts, false, signal);
  if (helper) {
    helper.lamps.forEach(report);
    if (!found.size && !signal?.aborted) {
      // Routers often keep lights on a range of their own, so look next door too.
      onProgress("Searching nearby networks");
      helper = (await askHelper(hintHosts, true, signal)) || helper;
      helper.lamps.forEach(report);
    }
    if (!found.size && !signal?.aborted) {
      // The helper can be kept off the network (macOS Local Network privacy) while this page isn't,
      // so check the addresses this page already knows itself.
      onProgress("Checking lamps you've used before");
      await Promise.all(hintHosts.filter((h) => prefix(h)).map(async (host) => {
        const info = await getJson(`http://${host}/json/info`, PROBE_MS, signal);
        if (isGlorb(info)) report({ address: info.ip || host, name: info.name || "Glorb", mac: info.mac, ver: info.ver });
      }));
    }
    return { lamps: [...found.values()], via: "helper", others: helper.others || 0, warning: helper.blocked };
  }

  if (location.protocol === "https:") return { lamps: [], via: "none", blocked: true };

  const asked = new Set();
  let others = 0;
  const probe = async (host) => {
    if (!host || asked.has(host) || signal?.aborted) return;
    asked.add(host);
    const info = await getJson(`http://${host}/json/info`, PROBE_MS, signal);
    if (!info?.leds) return;
    if (!isGlorb(info)) {
      others += 1;
      return;
    }
    const address = info.ip || host;
    asked.add(address);
    report({ address, name: info.name || "Glorb", mac: info.mac, ver: info.ver });
    // WLED keeps a list of the other WLED lights it has heard, which finds lamps on other ranges too.
    const nodes = await getJson(`http://${address}/json/nodes`, PROBE_MS, signal);
    await Promise.all((nodes?.nodes || []).map((node) => probe(node.ip)));
  };
  const sweep = async (hosts) => {
    let next = 0;
    const worker = async () => {
      while (next < hosts.length && !signal?.aborted) await probe(hosts[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, hosts.length) }, worker));
  };

  onProgress("Checking lamps you've used before");
  await sweep([...new Set([...hintHosts.filter((h) => h !== "localhost" && h !== "127.0.0.1"), ...NAMES])]);

  const known = [...new Set(hintHosts.map(prefix).filter(Boolean))];
  const guessed = COMMON.filter((p) => !known.includes(p));
  for (const range of [...known, ...guessed]) {
    // Once a lamp turns up, the network is known, so stop guessing at others.
    if (signal?.aborted || (found.size && guessed.includes(range))) break;
    onProgress(`Checking ${range}.x`);
    await sweep(Array.from({ length: 254 }, (_, i) => `${range}.${i + 1}`));
  }
  return { lamps: [...found.values()], via: "browser", others };
}

/** Guesses where Home Assistant is, so its address can be filled in. Returns "" when it can't tell. */
export async function findHomeAssistant(signal) {
  if (location.protocol === "https:") return "";
  const timer = new AbortController();
  const clock = setTimeout(() => timer.abort(), 2500);
  signal?.addEventListener("abort", () => timer.abort(), { once: true });
  try {
    // Home Assistant doesn't allow other pages to read it, but an opaque answer still proves it's there.
    await fetch("http://homeassistant.local:8123/manifest.json", { mode: "no-cors", signal: timer.signal });
    return "homeassistant.local:8123";
  } catch {
    return "";
  } finally {
    clearTimeout(clock);
  }
}
