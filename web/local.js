// Runs Glorb effects in the browser for links with no Home Assistant behind them.
// It answers the studio's calls the way the integration does, and hands each frame
// to the link to show and, for a real lamp, to send.

import { Engine, engineCatalog } from "./engine/engine.js";
import { Mic } from "./engine/mic.js";

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows can refuse storage. Looks then last until the page closes.
  }
}

/** Reads an image into pixels, small enough to sample quickly. */
function loadPicture(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 360;
      canvas.height = 180;
      const g = canvas.getContext("2d");
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        resolve(g.getImageData(0, 0, canvas.width, canvas.height));
      } catch {
        reject(new Error("That site doesn't let other pages read its pictures."));
      }
    };
    img.onerror = () => reject(new Error("That picture didn't load."));
    img.src = source;
  });
}

export class LocalStudio {
  /**
   * @param {object} options
   * @param {string} options.storage  where this lamp's looks and settings are kept
   * @param {number} options.fps  frames per second to render
   * @param {(display: Uint8Array) => void} options.onFrame  called with each frame, in LED order
   * @param {() => void} options.onChange  called when the state the studio shows changes
   * @param {() => void} [options.onRelease]  called when effects stop, to hand the lamp back
   */
  constructor({ storage, fps = 30, onFrame, onChange, onRelease = () => {} }) {
    this.storage = storage;
    this.onRelease = onRelease;
    this.fps = fps;
    this.onFrame = onFrame;
    this.onChange = onChange;
    this.running = false;
    this.measured = 0;
    this.fault = null;
    this.saved = load(storage, null) || { looks: {}, params: {}, globals: {} };
  }

  async ready(map) {
    if (this.engine) return;
    this.engine = new Engine(map);
    this.engine.setGlobals(this.saved.globals);
    this.mic = new Mic(this.engine.audio);
  }

  catalog() {
    return engineCatalog();
  }

  /** The parts of the state that come from the effects, merged into the link's own state. */
  state() {
    return {
      running: this.running,
      fps: this.running ? Math.round(this.measured * 10) / 10 : 0,
      fault: this.fault,
      looks: Object.keys(this.saved.looks).sort(),
      ...(this.engine ? this.engine.snapshot() : { effect: null, params: {}, globals: {}, audio_active: false }),
    };
  }

  _store() {
    save(this.storage, this.saved);
  }

  _remember() {
    const fx = this.engine.current;
    if (!fx || fx.id === "calibrate") return;
    this.saved.params[fx.id] = { ...fx.p };
    this._store();
  }

  _loop() {
    clearInterval(this.timer);
    let last = performance.now();
    let windowStart = last;
    let frames = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      try {
        this.mic.update(dt, now / 1000);
        this.onFrame(this.engine.step(dt));
      } catch (err) {
        // Keep the page alive through a bad effect, and say so.
        console.error("Glorb effect failed", err);
        this.fault = `The ${this.engine.current?.constructor.name || "current"} effect stopped with an error`;
        this.release();
        return;
      }
      frames += 1;
      if (now - windowStart >= 1000) {
        this.measured = (frames * 1000) / (now - windowStart);
        frames = 0;
        windowStart = now;
        this.onChange();
      }
    }, 1000 / this.fps);
  }

  async _picture(fx) {
    if (fx?.id !== "picture" || !fx.p.source) return;
    try {
      fx.image = await loadPicture(fx.p.source);
    } catch (err) {
      console.warn("Glorb:", err.message);
    }
  }

  play(effect, params = {}, transition = null, { remember = true } = {}) {
    const fx = this.engine.play(effect, { ...(remember ? this.saved.params[effect] : {}), ...params }, transition);
    this.fault = null;
    if (fx.constructor.category === "Music") this.mic.start().then(() => this.onChange());
    if (!this.running) {
      this.running = true;
      this._loop();
    }
    if (remember) this._remember();
    this._picture(fx);
    this.onChange();
  }

  setParams(values) {
    this.engine.setParams(values);
    this._remember();
    if ("source" in values) this._picture(this.engine.current);
    this.onChange();
  }

  setGlobals(values) {
    this.engine.setGlobals(values);
    this.saved.globals = { ...this.engine.globals };
    this._store();
    this.onChange();
  }

  alert(options) {
    if (!this.running) {
      // Alerts need the engine, so give the lamp back to its own effect afterward.
      this.play("solid", { color: "#000000" }, 0, { remember: false });
      const duration = Math.max(0.1, Number(options.duration) || 3);
      setTimeout(() => {
        const last = this.engine.overlays[this.engine.overlays.length - 1];
        if (!last || last.started + last.duration <= this.engine.clock + 0.2) this.release();
      }, duration * 1000 + 100);
    }
    this.engine.alert(options);
  }

  release() {
    const was = this.running;
    clearInterval(this.timer);
    this.running = false;
    this.engine?.stop();
    this.mic?.stop();
    if (was) this.onRelease();
    this.onChange();
  }

  saveLook(name) {
    const fx = this.engine.current;
    if (!fx) throw new Error("Play an effect first, then save it as a look");
    this.saved.looks[name] = { effect: fx.id, params: { ...fx.p }, globals: { ...this.engine.globals } };
    this._store();
    this.onChange();
  }

  deleteLook(name) {
    delete this.saved.looks[name];
    this._store();
    this.onChange();
  }

  playLook(name) {
    const look = this.saved.looks[name];
    if (!look) throw new Error(`There's no look called ${name}`);
    this.engine.setGlobals(look.globals);
    this.play(look.effect, look.params);
  }

  /** Answer the studio's calls that are about effects. Returns false for ones it doesn't handle. */
  handle(type, extra) {
    if (type === "glorb/play") this.play(extra.effect, extra.params, extra.transition);
    else if (type === "glorb/params") this.setParams(extra.params);
    else if (type === "glorb/globals") this.setGlobals(extra.values);
    else if (type === "glorb/alert") this.alert(extra);
    else if (type === "glorb/release") this.release();
    else if (type === "glorb/look_save") this.saveLook(extra.name);
    else if (type === "glorb/look_delete") this.deleteLook(extra.name);
    else if (type === "glorb/look_play") this.playLook(extra.name);
    else return false;
    return true;
  }
}
