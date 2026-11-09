// Ways to reach a lamp. Each link gives the studio the same catalog, state and calls.
// Home Assistant runs effects itself. The other links run them here, in the browser.

import { LocalStudio } from "./local.js";

const STALE_MS = 8000;
const RETRY_MS = 3000;
// Each frame goes to the lamp as JSON, which the firmware can take about this often.
const LAMP_FPS = 20;
const LAMP_BACKLOG = 4096;
// While a page plays effects on a lamp, it names the lamp's segment after itself. Another
// page or device that sees a different name there knows it has been taken over and stops,
// so two pages never paint the lamp at once.
const CLAIM = "Glorby ";
const CLAIM_CHECK_MS = 2500;

/** The lamp's own effect, as a Glorby claim name ("Glorby abc123~67") carries it, or null. */
function claimedFx(name) {
  const match = /~(\d+)$/.exec(String(name || ""));
  return match ? Number(match[1]) : null;
}
// The Glorb firmware's own add-on, in the lamp's settings.
const ADDON = "GLORB";

async function lampMap() {
  const response = await fetch(new URL("./lamp-map.json", import.meta.url));
  return response.json();
}

function blockedByBrowser(url) {
  return location.protocol === "https:" && url.startsWith("http:");
}

const BLOCKED = "This secure page can't reach a device on your network. Open the app from the device's own address.";

/** Talks straight to a lamp's WLED interface, with no Home Assistant involved. */
export class WledLink {
  constructor(address) {
    this.base = address ? `http://${address}` : location.origin;
    this.title = "Glorb";
    this.handlers = new Set();
    this.lamp = { state: {}, info: {} };
    this.available = true;
    this.local = new LocalStudio({
      storage: `glorby.lamp.${address || location.host}`,
      onFrame: (display) => this._show(display),
      onChange: () => this._emit(this.available),
      onRelease: () => this._handBack(),
    });
    this.token = Math.random().toString(36).slice(2, 8);
    // Closing the page while effects play gives the lamp back, add-on included.
    addEventListener("pagehide", () => this.local.release());
    // Other tabs in this browser hear about a takeover at once, without waiting on the lamp.
    this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`glorby:${this.base}`) : null;
    if (this.channel) {
      this.channel.onmessage = ({ data }) => {
        if (data?.claim && data.claim !== this.token) this._yield();
      };
    }
  }

  async _get(path) {
    if (blockedByBrowser(this.base)) throw new Error(BLOCKED);
    let response;
    try {
      response = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(6000) });
    } catch {
      throw new Error("That address didn't answer. Check it and that the lamp is on.");
    }
    if (!response.ok) throw new Error("That address answered, but it isn't a lamp.");
    return response.json();
  }

  /** Throws a message a person can act on when the address isn't a WLED lamp. */
  async check() {
    const info = await this._get("/json/info");
    if (!info.leds) throw new Error("That address answered, but it isn't a lamp.");
    this.lamp.info = info;
    this.title = info.name || "Glorb";
    return info;
  }

  async catalog() {
    if (!this.lamp.info.leds) await this.check();
    const [map, effects, fxdata, palettes, presets] = await Promise.all([
      lampMap(),
      this._get("/json/effects"),
      this._get("/json/fxdata").catch(() => []),
      this._get("/json/pal"),
      this._get("/presets.json").catch(() => ({})),
    ]);
    this.cells = map.cells;
    await this.local.ready(map);
    const named = {};
    Object.entries(presets).forEach(([id, preset]) => {
      if (id !== "0" && preset.n) named[id] = preset.n;
    });
    return {
      ...this.local.catalog(),
      wled_effects: effects,
      wled_fxdata: fxdata,
      wled_palettes: palettes,
      wled_presets: named,
      geometry: { vertices: map.vertices, faces: map.faces },
    };
  }

  _emit(available) {
    this.available = available;
    const { state, info } = this.lamp;
    const seg = (state.seg || [{}])[0];
    const effects = this.local.state();
    const message = {
      s: {
        ...effects,
        available,
        fault: available ? effects.fault : "The lamp stopped answering",
        on: !!state.on,
        bri: state.bri ?? 0,
        wled: {
          fx: seg.fx,
          sx: seg.sx,
          ix: seg.ix,
          pal: seg.pal,
          ps: state.ps,
          ver: info.ver,
          signal: info.wifi?.signal,
          power: info.leds?.pwr,
        },
        orientation: {},
      },
    };
    this.handlers.forEach((handler) => handler(message));
  }

  /** Show a frame from the effects here, and send it to the lamp. */
  _show(display) {
    this.handlers.forEach((handler) => handler({ rgb: display }));
    const socket = this.socket;
    const now = performance.now();
    if (!this.cells || socket?.readyState !== WebSocket.OPEN) return;
    // A slow lamp gets fewer frames rather than a growing queue.
    // Checked from the frame loop, which keeps going in a background tab when timers slow down.
    if (now - (this.checkedAt || 0) > CLAIM_CHECK_MS) {
      this.checkedAt = now;
      this._checkClaim();
    }
    if (now - (this.sentAt || 0) < 1000 / LAMP_FPS - 2 || socket.bufferedAmount > LAMP_BACKLOG) return;
    this.sentAt = now;
    // Colors go to the lamp's matrix cells. Cells with no LED stay black.
    const cells = new Array(120).fill("000000");
    this.cells.forEach((cell, led) => {
      cells[cell] = [0, 1, 2].map((c) => display[led * 3 + c].toString(16).padStart(2, "0")).join("");
    });
    socket.send(JSON.stringify({ seg: { i: cells } }));
  }

  _mainSegment() {
    const { state } = this.lamp;
    return state.mainseg ?? (state.seg || [])[0]?.id ?? 0;
  }

  /**
   * Take the lamp for effects played here. Tells other pages to stop, makes the lamp ignore
   * live data from anywhere else (Home Assistant streams that), and turns off any other
   * segment so only this page's frames show.
   */
  async _claim() {
    this.channel?.postMessage({ claim: this.token });
    const main = this._mainSegment();
    const segments = this.lamp.state.seg || [];
    if (!this.claim) {
      const current = segments.find((seg) => seg.id === main) || {};
      const takenOver = String(current.n || "").startsWith(CLAIM);
      this.claim = {
        name: takenOver ? "" : current.n || "",
        others: segments.filter((seg) => seg.id !== main && seg.on).map((seg) => seg.id),
        // The lamp's own effect, put back afterward. Glorb firmware's add-on draws its
        // effect even on a frozen segment, so the segment is switched to plain Solid.
        // A page taking over from another Glorby page (often its own earlier copy, before a
        // reload) reads the effect that page saved in the claim name.
        fx: takenOver ? claimedFx(current.n) : current.fx ?? null,
        addons: null,
      };
      // The firmware's own Glorb add-on flashes its own lights over the frames once a second.
      // Only its saved settings turn it off, so it rests there while frames come from here.
      // A page that took over from another Glorby page finds it resting already, and puts it
      // back on when done.
      this.claim.addons = await this._restAddon(takenOver).catch(() => null);
    }
    // The lamp's own effect rides in the claim name, so whoever takes over can still put it back.
    this.claimed = `${CLAIM}${this.token}${this.claim.fx !== null ? `~${this.claim.fx}` : ""}`;
    await this._post({
      on: true,
      lor: 2,
      seg: [{ id: main, n: this.claimed, fx: 0 }, ...this.claim.others.map((id) => ({ id, on: false }))],
    });
    this.socket?.readyState === WebSocket.OPEN && this.socket.send(JSON.stringify({ lv: false }));
    this.checkedAt = performance.now();
  }

  /**
   * Turn off the firmware's Glorb add-on in the lamp's settings. Returns every add-on's
   * on/off setting to restore afterward, or null when there's nothing to put back.
   * Each write names every add-on, because one that's left out can come back on.
   */
  async _restAddon(wasOurs) {
    const cfg = await this._get("/json/cfg");
    const um = cfg.um || {};
    if (!um[ADDON]) return null;
    const addons = Object.fromEntries(Object.entries(um).map(([name, value]) => [name, !!value?.enabled]));
    // This browser rested it before and never got to put it back, say because the lamp hung.
    if (wasOurs || this._rested()) addons[ADDON] = true;
    if (!addons[ADDON]) return null;
    this._rested(addons);
    await this._settings({ ...addons, [ADDON]: false });
    return addons;
  }

  /**
   * The add-on settings this browser owes the lamp, kept so a page that dies or a lamp that
   * hangs mid-effect can't leave the add-on off for good. Pass a value to store it, or null to clear.
   */
  _rested(addons) {
    const key = `glorby.rested.${this.base}`;
    try {
      if (addons === undefined) return JSON.parse(localStorage.getItem(key));
      if (addons) localStorage.setItem(key, JSON.stringify(addons));
      else localStorage.removeItem(key);
    } catch {
      // Without storage, the page puts the add-on back only when it stops normally.
    }
    return null;
  }

  /** Put back an add-on this browser left resting, once no page is playing on the lamp. */
  async _restoreOwed(state) {
    if (this.owedChecked || this.local.running) return;
    this.owedChecked = true;
    const owed = this._rested();
    const main = (state.seg || []).find((seg) => seg.id === (state.mainseg ?? 0));
    if (!owed || String(main?.n || "").startsWith(CLAIM)) return;
    try {
      // Firmware without the add-on (Glorby's own build, plain WLED) has nothing to put back,
      // and only add-ons this firmware still has are written.
      const um = (await this._get("/json/cfg")).um || {};
      if (!um[ADDON]) {
        this._rested(null);
        return;
      }
      const still = Object.fromEntries(Object.entries(owed).filter(([name]) => name in um));
      await this._settings(still);
    } catch {
      // The lamp didn't answer. The record stays, so the next visit tries again.
    }
  }

  _settings(addons) {
    if (addons[ADDON]) this._rested(null);
    const um = Object.fromEntries(Object.entries(addons).map(([name, enabled]) => [name, { enabled }]));
    return fetch(`${this.base}/json/cfg`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ um }),
      keepalive: true,
    });
  }

  /** True when the lamp's state shows another Glorby page has claimed it. */
  _takenBy(state) {
    const main = (state.seg || []).find((seg) => seg.id === (state.mainseg ?? 0));
    const name = String(main?.n || "");
    return !!this.claimed && name.startsWith(CLAIM) && name !== this.claimed;
  }

  /**
   * True when the lamp has forgotten this page's claim without anyone else taking it.
   * A restart does that, and then Home Assistant may resume streaming over the top.
   */
  _lostClaim(state) {
    const main = (state.seg || []).find((seg) => seg.id === (state.mainseg ?? 0));
    return !!this.claimed && (main?.n !== this.claimed || state.lor !== 2 || main?.fx !== 0);
  }

  /** Stop if another page or device has taken the lamp since, and claim it again after a restart. */
  async _checkClaim() {
    if (!this.local.running || !this.claimed) return;
    try {
      const state = await this._get("/json/state");
      if (this._takenBy(state)) this._yield();
      else if (this._lostClaim(state)) this._claim();
    } catch {
      // The lamp being briefly unreachable isn't a takeover.
    }
  }

  /** Another page took the lamp: stop here and leave the lamp to it. */
  _yield() {
    if (!this.local.running) return;
    this.claimed = null;
    this.claim = null;
    this.local.onRelease = () => {};
    this.local.release();
    this.local.onRelease = () => this._handBack();
    this.local.fault = "Another window or device is playing effects on this lamp now";
    this._emit(this.available);
  }

  /** Give the lamp back its own effect, and live data back to Home Assistant, after effects here stop. */
  _handBack() {
    this.socket?.readyState === WebSocket.OPEN && this.socket.send(JSON.stringify({ lv: true }));
    const claim = this.claim || { name: "", others: [], fx: null, addons: null };
    this.claim = null;
    this.claimed = null;
    if (claim.addons) this._settings(claim.addons).catch(() => {});
    const handed = this._post({
      lor: 0,
      seg: [
        { id: this._mainSegment(), frz: false, n: claim.name, ...(claim.fx !== null ? { fx: claim.fx } : {}) },
        ...claim.others.map((id) => ({ id, on: true })),
      ],
    });
    // With no effect to put back, the lamp would sit on plain Solid. Its start-up preset
    // brings back a proper look instead.
    if (claim.fx === null) {
      return handed
        .then(() => this._get("/json/cfg"))
        .then((cfg) => cfg?.def?.ps > 0 && this._post({ ps: cfg.def.ps }))
        .catch(() => {});
    }
    return handed.catch(() => {});
  }

  _open() {
    if (this.closed) return;
    const url = this.base.replace(/^http/, "ws");
    const socket = new WebSocket(`${url}/ws`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    // The lamp's own live view is only needed while it plays its own effects.
    socket.onopen = () => {
      this.owedChecked = false;
      socket.send(JSON.stringify({ lv: !this.local.running }));
      // The lamp may have restarted while away, which forgets the claim.
      if (this.local.running && this.claimed) this._claim().catch(() => {});
    };
    socket.onmessage = (event) => {
      this.heard = Date.now();
      if (typeof event.data === "string") {
        const data = JSON.parse(event.data);
        if (data.state) {
          this.lamp.state = data.state;
          this._restoreOwed(data.state);
          if (this._takenBy(data.state)) this._yield();
        }
        if (data.info) this.lamp.info = data.info;
        this._emit(true);
        return;
      }
      this._frame(new Uint8Array(event.data));
    };
    socket.onclose = () => {
      if (this.closed) return;
      this._emit(false);
      this.retry = setTimeout(() => this._open(), RETRY_MS);
    };
  }

  _frame(data) {
    // The firmware's live view: "L", version 2, width, height, then RGB per matrix cell.
    if (data[0] !== 76 || data[1] !== 2 || !this.cells || this.local.running) return;
    const header = 4;
    const rgb = new Uint8Array(this.cells.length * 3);
    this.cells.forEach((cell, led) => {
      const from = header + cell * 3;
      rgb[led * 3] = data[from];
      rgb[led * 3 + 1] = data[from + 1];
      rgb[led * 3 + 2] = data[from + 2];
    });
    this.handlers.forEach((handler) => handler({ rgb }));
  }

  async subscribe(onMessage) {
    this.handlers.add(onMessage);
    this.closed = false;
    this.heard = Date.now();
    this._open();
    // A hung lamp holds its socket open and just goes quiet, so silence counts as gone.
    const watchdog = setInterval(() => {
      if (Date.now() - this.heard > STALE_MS && this.socket.readyState === WebSocket.OPEN) this.socket.close();
    }, 2000);
    return () => {
      this.closed = true;
      this.local.release();
      clearInterval(watchdog);
      clearTimeout(this.retry);
      this.socket?.close();
      this.handlers.delete(onMessage);
    };
  }

  async _post(body) {
    await fetch(`${this.base}/json/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Lets the hand-back finish when the page is closing.
      keepalive: true,
    });
  }

  async call(type, extra = {}) {
    if (type === "glorb/power") {
      if (extra.on === false) this.local.release();
      return this._post(extra);
    }
    if (type === "glorb/play" || type === "glorb/look_play" || (type === "glorb/alert" && !this.local.running)) {
      await this._claim();
    }
    if (this.local.handle(type, extra)) return undefined;
    if (type === "glorb/wled") {
      if (this.local.running) {
        this.local.onRelease = () => {};
        this.local.release();
        this.local.onRelease = () => this._handBack();
        await this._handBack();
      }
      if (extra.preset !== undefined) return this._post({ ps: extra.preset });
      if (extra.fx !== undefined) return this._post({ seg: [{ fx: extra.fx }] });
      if (extra.seg) return this._post({ seg: [extra.seg] });
    }
    throw new Error(`${type} isn't available on this connection`);
  }
}

/** Reaches the Glorb integration in a Home Assistant from outside it, using an access token. */
export class HomeAssistantLink {
  constructor(address, token) {
    this.base = /^https?:\/\//.test(address) ? address.replace(/\/+$/, "") : `http://${address}`;
    this.token = token;
    this.title = "Glorb";
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.states = [];
  }

  _connect() {
    if (this.opening) return this.opening;
    if (blockedByBrowser(this.base)) return Promise.reject(new Error(BLOCKED));
    this.opening = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(`${this.base.replace(/^http/, "ws")}/api/websocket`);
      } catch {
        reject(new Error("That isn't a usable address."));
        return;
      }
      this.socket = socket;
      socket.onerror = () => reject(new Error("Home Assistant didn't answer at that address."));
      socket.onclose = () => {
        this.opening = null;
        this.pending.forEach(({ reject: fail }) => fail(new Error("Connection to Home Assistant closed.")));
        this.pending.clear();
      };
      socket.onmessage = (event) => {
        const m = JSON.parse(event.data);
        if (m.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
        else if (m.type === "auth_invalid") reject(new Error("Home Assistant refused that access token."));
        else if (m.type === "auth_ok") resolve();
        else if (m.type === "result") {
          const waiting = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.success) waiting?.resolve(m.result);
          else waiting?.reject(new Error(m.error?.message || "Home Assistant refused that."));
        } else if (m.type === "event") this.listeners.get(m.id)?.(m.event);
      };
    });
    return this.opening;
  }

  async _send(message) {
    await this._connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ ...message, id }));
      message.onId?.(id);
    });
  }

  async check() {
    await this._connect();
    const devices = await this._send({ type: "glorb/devices" }).catch(() => {
      throw new Error("Glorb isn't installed in this Home Assistant.");
    });
    if (!devices.length) throw new Error("Glorb is installed, but no lamp is set up in it.");
    this.device = devices[0].id;
    this.title = devices[0].name || "Glorb";
    this.states = await this._send({ type: "get_states" });
  }

  async catalog() {
    if (!this.device) await this.check();
    return this._send({ type: "glorb/catalog", device: this.device });
  }

  async subscribe(onMessage) {
    await this._connect();
    const id = this.nextId++;
    this.listeners.set(id, onMessage);
    this.socket.send(JSON.stringify({ type: "glorb/subscribe", device: this.device, id }));
    return () => {
      this.listeners.delete(id);
      this.socket?.close();
    };
  }

  call(type, extra = {}) {
    return this._send({ type, device: this.device, ...extra });
  }

  entities(domains) {
    return this.states
      .filter((s) => domains.includes(s.entity_id.split(".")[0]))
      .map((s) => ({ id: s.entity_id, name: s.attributes.friendly_name || s.entity_id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** A pretend lamp: lets people try every effect, and is the bench for checking every control. */
export class DemoLink {
  constructor({ awkward = false } = {}) {
    this.awkward = awkward;
    this.title = awkward ? "Upstairs office lamp with a very long name that has to wrap somewhere" : "Demo lamp";
    this.handlers = new Set();
    this.local = new LocalStudio({
      storage: awkward ? "glorby.bench" : "glorby.demo",
      onFrame: (display) => this.handlers.forEach((handler) => handler({ rgb: this._dim(display) })),
      onChange: () => this._announce(),
      onRelease: () => this.handlers.forEach((handler) => handler({ rgb: new Uint8Array(240) })),
    });
    this.state = {
      available: !awkward,
      fault: awkward ? "The lamp stopped answering while playing a very long effect name" : null,
      on: true,
      bri: 200,
      wled: { fx: 0, sx: 128, ix: 128, pal: 0, ps: -1, ver: "demo", signal: 90, power: 900 },
      orientation: {},
    };
  }

  async catalog() {
    const map = await lampMap();
    await this.local.ready(map);
    const catalog = this.local.catalog();
    if (this.awkward) {
      const aurora = catalog.effects.find((fx) => fx.id === "aurora");
      catalog.effects.push({ ...aurora, id: "long", name: "An effect with a remarkably long name" });
    }
    return {
      ...catalog,
      // The effect names of a real lamp (firmware 0.14), so the lamp effects tab looks as it will.
      wled_effects: await fetch(new URL("./demo-lamp-effects.json", import.meta.url)).then((r) => r.json()),
      wled_palettes: ["Default", "Random Cycle", "Party"],
      wled_presets: { 1: "Default", 2: this.awkward ? "A preset with a long name that needs to wrap" : "Night" },
      geometry: { vertices: map.vertices, faces: map.faces },
    };
  }

  /** A switched off demo lamp goes dark, as a real one would. */
  _dim(display) {
    return this.state.on ? display : new Uint8Array(display.length);
  }

  _announce() {
    const effects = this.local.state();
    const message = {
      s: {
        ...effects,
        ...this.state,
        effect: this.playingLong && effects.effect === "aurora" ? "long" : effects.effect,
        fault: this.state.fault || effects.fault,
        audio_active: effects.audio_active || this.awkward,
        looks: this.awkward ? ["Movie night in the upstairs office with the blinds down", ...effects.looks] : effects.looks,
      },
    };
    this.handlers.forEach((handler) => handler(message));
  }

  async subscribe(onMessage) {
    this.handlers.add(onMessage);
    if (!this.local.running) this.local.play("aurora");
    this._announce();
    return () => {
      this.handlers.delete(onMessage);
      if (!this.handlers.size) this.local.release();
    };
  }

  async call(type, extra = {}) {
    const s = this.state;
    if (type === "glorb/play") {
      s.fault = null;
      s.available = true;
      this.playingLong = extra.effect === "long";
      if (this.playingLong) extra = { ...extra, effect: "aurora" };
    }
    if (type === "glorb/power") {
      Object.assign(s, extra);
      if (extra.on === false) this.local.release();
    }
    if (type === "glorb/wled") {
      this.local.release();
      if (extra.preset !== undefined) s.wled.ps = extra.preset;
      if (extra.fx !== undefined) s.wled.fx = extra.fx;
      Object.assign(s.wled, extra.seg || {});
    }
    this.local.handle(type, extra);
    this._announce();
  }
}
