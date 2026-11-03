// Ways to reach a lamp. Each link gives the studio the same catalog, state and calls.
// Home Assistant runs effects itself. The other links run them here, in the browser.

import { LocalStudio } from "./local.js";

const STALE_MS = 8000;
const RETRY_MS = 3000;
// Each frame goes to the lamp as JSON, which the firmware can take about this often.
const LAMP_FPS = 20;
const LAMP_BACKLOG = 4096;

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
    const [map, effects, palettes, presets] = await Promise.all([
      lampMap(),
      this._get("/json/effects"),
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
    if (now - (this.sentAt || 0) < 1000 / LAMP_FPS - 2 || socket.bufferedAmount > LAMP_BACKLOG) return;
    this.sentAt = now;
    // Colors go to the lamp's matrix cells. Cells with no LED stay black.
    const cells = new Array(120).fill("000000");
    this.cells.forEach((cell, led) => {
      cells[cell] = [0, 1, 2].map((c) => display[led * 3 + c].toString(16).padStart(2, "0")).join("");
    });
    socket.send(JSON.stringify({ seg: { i: cells } }));
  }

  /** Give the lamp back its own effect after effects here stop. */
  _handBack() {
    this.socket?.readyState === WebSocket.OPEN && this.socket.send(JSON.stringify({ lv: true }));
    return this._post({ seg: [{ frz: false }] }).catch(() => {});
  }

  _open() {
    if (this.closed) return;
    const url = this.base.replace(/^http/, "ws");
    const socket = new WebSocket(`${url}/ws`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    // The lamp's own live view is only needed while it plays its own effects.
    socket.onopen = () => socket.send(JSON.stringify({ lv: !this.local.running }));
    socket.onmessage = (event) => {
      this.heard = Date.now();
      if (typeof event.data === "string") {
        const data = JSON.parse(event.data);
        if (data.state) this.lamp.state = data.state;
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
    });
  }

  async call(type, extra = {}) {
    if (type === "glorb/power") {
      if (extra.on === false) this.local.release();
      return this._post(extra);
    }
    if (type === "glorb/play" || type === "glorb/look_play") {
      await this._post({ on: true });
      this.socket?.readyState === WebSocket.OPEN && this.socket.send(JSON.stringify({ lv: false }));
    }
    if (this.local.handle(type, extra)) return undefined;
    if (type === "glorb/wled") {
      if (this.local.running) {
        this.local.onRelease = () => {};
        this.local.release();
        this.local.onRelease = () => this._handBack();
        this.socket?.readyState === WebSocket.OPEN && this.socket.send(JSON.stringify({ lv: true }));
        await this._post({ seg: [{ frz: false }] });
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
      wled_effects: ["Solid", "Blink", "Breathe", "Wipe", "RSVD", "Rainbow"],
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
