// Runs effects in the browser: crossfades, alerts, spin and color controls, the same
// as core/engine.py does inside Home Assistant.

import * as palettes from "./palettes.js";
import { CATEGORIES, REGISTRY } from "./effects.js";
import { LED_COUNT, Random, SWEEP_DIRECTIONS, SWEEP_PASSES, buildGeometry, clamp, mod, setNoise, sweepMask } from "./sphere.js";

export const OVERLAY_PATTERNS = ["pulse", "flash", "ring", "sweep", "split", "spin"];

export function newAudio() {
  return { active: false, level: 0, bass: 0, mid: 0, treble: 0, beat: 0, bins: new Float64Array(16) };
}

/** What the engine offers, in the shape Home Assistant's catalog uses. */
export function engineCatalog() {
  return {
    categories: [...CATEGORIES],
    effects: Object.values(REGISTRY).map((fx) => fx.describe()),
    palettes: { ...palettes.STOPS },
    patterns: [...OVERLAY_PATTERNS],
    sweep_directions: [...SWEEP_DIRECTIONS],
  };
}

function hueRotate(rgb, degrees, saturation) {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const one = 1 / 3;
  const root = Math.sqrt(one);
  const m = [
    [c + (1 - c) * one, one * (1 - c) - root * s, one * (1 - c) + root * s],
    [one * (1 - c) + root * s, c + one * (1 - c), one * (1 - c) - root * s],
    [one * (1 - c) - root * s, one * (1 - c) + root * s, c + one * (1 - c)],
  ];
  for (let i = 0; i < LED_COUNT; i++) {
    const o = i * 3;
    const grey = rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114;
    const v = [0, 1, 2].map((k) => grey + (rgb[o + k] - grey) * saturation);
    for (let k = 0; k < 3; k++) {
      const out = degrees ? m[k][0] * v[0] + m[k][1] * v[1] + m[k][2] * v[2] : v[k];
      rgb[o + k] = clamp(out, 0, 1);
    }
  }
}

export class Engine {
  constructor(map, { random = Math.random, stateOf = () => null } = {}) {
    if (map.noise) setNoise(map.noise);
    this.geo = buildGeometry(map);
    this.rng = new Random(random);
    this.stateOf = stateOf;
    this.globals = { spin: 0, tumble: 0, hue: 0, saturation: 1, gain: 1, gamma: 2.8, transition: 1 };
    this.audio = newAudio();
    this.current = null;
    this.previous = null;
    this.fadeLeft = 0;
    this.fadeTotal = 1;
    this.overlays = [];
    this.clock = 0;
    this.spinAngle = 0;
    this.tumbleAngle = 0;
    this.now = () => new Date();
  }

  play(effectId, params = null, transition = null) {
    const Fx = REGISTRY[effectId];
    if (!Fx) throw new Error(`There's no effect called ${effectId}`);
    const fx = new Fx(this.geo, this.rng);
    if (params) fx.set(params);
    if (this.current) {
      this.previous = this.current;
      this.fadeTotal = this.fadeLeft = Math.max(0, transition ?? this.globals.transition);
      if (this.fadeTotal === 0) this.previous = null;
    }
    this.current = fx;
    return fx;
  }

  stop() {
    this.current = null;
    this.previous = null;
    this.overlays = [];
  }

  setParams(values) {
    this.current?.set(values);
  }

  setGlobals(values) {
    Object.entries(values || {}).forEach(([key, value]) => {
      if (key in this.globals && Number.isFinite(Number(value))) this.globals[key] = Number(value);
    });
  }

  alert({ pattern = "pulse", color = "#ff0000", color2 = "#000000", duration = 3, opacity = 1, direction = SWEEP_DIRECTIONS[0], speed = 1, width = 0.5 } = {}) {
    const origin = this.rng.normal3();
    const length = Math.hypot(...origin) || 1;
    this.overlays.push({
      pattern: OVERLAY_PATTERNS.includes(pattern) ? pattern : "pulse",
      color: palettes.color(color),
      color2: palettes.color(color2),
      started: this.clock,
      duration: Math.max(0.1, Number(duration) || 3),
      origin: origin.map((v) => v / length),
      opacity: clamp(Number(opacity), 0, 1),
      direction: SWEEP_DIRECTIONS.includes(direction) ? direction : SWEEP_DIRECTIONS[0],
      speed: clamp(Number(speed), 0, 4),
      width: clamp(Number(width), 0.15, 1.5),
    });
  }

  snapshot() {
    return {
      effect: this.current ? this.current.id : null,
      params: this.current ? { ...this.current.p } : {},
      globals: { ...this.globals },
      audio_active: this.audio.active,
    };
  }

  _ctx(dt) {
    const g = this.globals;
    this.spinAngle += (dt * g.spin * 2 * Math.PI) / 60;
    this.tumbleAngle += (dt * g.tumble * 2 * Math.PI) / 60;
    let { pos, lat, lon } = this.geo;
    if (this.spinAngle || this.tumbleAngle) {
      const cz = Math.cos(this.spinAngle);
      const sz = Math.sin(this.spinAngle);
      const cx = Math.cos(this.tumbleAngle);
      const sx = Math.sin(this.tumbleAngle);
      // pos @ (Rz @ Rx), as row vectors.
      const m = [
        [cz, -sz * cx, sz * sx],
        [sz, cz * cx, -cz * sx],
        [0, sx, cx],
      ];
      pos = pos.map(([x, y, z]) => [0, 1, 2].map((j) => x * m[0][j] + y * m[1][j] + z * m[2][j]));
      lat = Float64Array.from(pos, (p) => Math.asin(clamp(p[2], -1, 1)));
      lon = Float64Array.from(pos, (p) => Math.atan2(p[1], p[0]));
    }
    return { pos, lat, lon, t: this.clock, dt, audio: this.audio, stateOf: this.stateOf, now: this.now() };
  }

  _overlays(rgb) {
    const { pos, lat, lon } = this.geo;
    this.overlays = this.overlays.filter((o) => (this.clock - o.started) / o.duration < 1);
    this.overlays.forEach((o) => {
      const age = this.clock - o.started;
      const envelope = Math.min(1, Math.min(age, o.duration - age) * 8);
      let mask;
      if (o.pattern === "flash") mask = new Float64Array(LED_COUNT).fill(Math.floor(age * 6) % 2 === 0 ? 1 : 0);
      else if (o.pattern === "ring") {
        const front = mod(age * 2.4, Math.PI);
        mask = Float64Array.from(pos, (p) => {
          const a = Math.acos(clamp(p[0] * o.origin[0] + p[1] * o.origin[1] + p[2] * o.origin[2], -1, 1));
          return Math.exp(-(((a - front) / 0.4) ** 2));
        });
      } else if (o.pattern === "sweep") mask = sweepMask(lat, lon, o.direction, age * o.speed * SWEEP_PASSES, o.width);
      else if (o.pattern === "split") mask = Float64Array.from(pos, (p) => (p[2] > Math.sin(age * 2) * 0.3 ? 1 : 0));
      else if (o.pattern === "spin") mask = Float64Array.from(lon, (l) => Math.max(0, Math.cos(l * 2 + age * 6)) ** 2);
      else mask = new Float64Array(LED_COUNT).fill(0.5 + 0.5 * Math.sin(age * 6 - 1.5));
      const strength = envelope * o.opacity;
      const two = o.color2.some((v) => v > 0);
      for (let i = 0; i < LED_COUNT; i++) {
        const m = mask[i];
        for (let c = 0; c < 3; c++) {
          const k = i * 3 + c;
          // Two colors replace the effect outright, one color lets it show through.
          if (two) rgb[k] = rgb[k] * (1 - strength) + (o.color[c] * m + o.color2[c] * (1 - m)) * strength;
          else rgb[k] = rgb[k] * (1 - m * strength) + o.color[c] * m * strength;
        }
      }
    });
  }

  /** Advance one frame. Returns 0..255 colors in LED order, before gamma. */
  step(dt) {
    this.clock += dt;
    const ctx = this._ctx(dt);
    let rgb = this.current ? this.current.frame(ctx) : new Float64Array(LED_COUNT * 3);
    if (this.previous && this.fadeLeft > 0) {
      this.fadeLeft -= dt;
      const mix = Math.max(0, this.fadeLeft / Math.max(this.fadeTotal, 1e-6));
      const old = this.previous.frame(ctx);
      rgb = rgb.map((v, i) => v * (1 - mix) + old[i] * mix);
      if (this.fadeLeft <= 0) this.previous = null;
    }
    this._overlays(rgb);
    const g = this.globals;
    if (g.hue || g.saturation !== 1) hueRotate(rgb, g.hue, g.saturation);
    const display = new Uint8Array(LED_COUNT * 3);
    for (let i = 0; i < rgb.length; i++) display[i] = Math.floor(clamp(rgb[i] * g.gain, 0, 1) * 255 + 0.5);
    return display;
  }
}
