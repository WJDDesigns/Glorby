// Every Glorb effect, ported from core/effects.py so the web app can run them without
// Home Assistant. Each effect gets every LED's 3D direction and returns a color for each.
// Keep the two in step: tools/check_web_effects.py compares them frame by frame.

import * as palettes from "./palettes.js";
import {
  LED_COUNT, TAU, SWEEP_DIRECTIONS, SWEEP_PASSES, angle, clamp, cross, degrees, dir, dot, fbm, mod, noise3,
  radians, smooth, sweepMask, unit,
} from "./sphere.js";

export const CATEGORIES = ["Worlds", "Faces", "Ambient", "Geometry", "Music", "Data", "Basics"];

const N = LED_COUNT;

// --- Settings ---------------------------------------------------------------

function param(key, name, kind, value, min = 0, max = 1, step = 0.01, options = []) {
  return { key, name, kind, default: value, min, max, step, options };
}
const range = (key, name, value, min, max, step) => param(key, name, "range", value, min, max, step);
const choice = (key, name, value, options) => param(key, name, "choice", value, 0, 1, 0.01, options);
const colorParam = (key, name, value) => param(key, name, "color", value);
const bool = (key, name, value) => param(key, name, "bool", value);
const speed = (value = 1) => range("speed", "Speed", value, 0, 4, 0.05);
const palette = (value) => choice("palette", "Palette", value, palettes.NAMES);
const facing = () => range("facing", "Facing", 0, -180, 180, 1);

function clean(p, value) {
  if (p.kind === "range") {
    const v = Number(value);
    return Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
  }
  if (p.kind === "bool") return !!value;
  if (p.kind === "choice") return p.options.includes(value) ? value : p.default;
  return String(value ?? "");
}

function describe(p) {
  const out = { key: p.key, name: p.name, kind: p.kind, default: p.default };
  if (p.kind === "range") Object.assign(out, { min: p.min, max: p.max, step: p.step });
  if (p.kind === "choice") out.options = [...p.options];
  return out;
}

// --- Frame helpers ----------------------------------------------------------

const frame = () => new Float64Array(N * 3);

function fill(rgb) {
  const out = frame();
  for (let i = 0; i < N; i++) out.set(rgb, i * 3);
  return out;
}

/** Brighten out toward rgb * k, channel by channel, like np.maximum. */
function maxInto(out, i, rgb, k) {
  const o = i * 3;
  for (let c = 0; c < 3; c++) out[o + c] = Math.max(out[o + c], rgb[c] * k);
}

function put(out, i, r, g, b) {
  const o = i * 3;
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}

/** Pick the one triangle closest to each (right, up) point, so features stay crisp. */
function nearest(view, points) {
  const mask = new Uint8Array(N);
  points.forEach(([r, u]) => {
    const f = Math.sqrt(Math.max(0, 1 - r * r - u * u));
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      const score = view.forward[i] * f + view.right[i] * r + view.up[i] * u;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    mask[best] = 1;
  });
  return mask;
}

// --- Effects ----------------------------------------------------------------

export const REGISTRY = {};

function effect(cls) {
  REGISTRY[cls.id] = cls;
  return cls;
}

export class Effect {
  static id = "";
  static name = "";
  static category = "Ambient";
  static params = [];

  constructor(geo, rng) {
    this.geo = geo;
    this.rng = rng;
    this.clock = 0;
    this.p = Object.fromEntries(this.constructor.params.map((x) => [x.key, x.default]));
  }

  get id() {
    return this.constructor.id;
  }

  set(values) {
    const known = Object.fromEntries(this.constructor.params.map((x) => [x.key, x]));
    Object.entries(values || {}).forEach(([key, value]) => {
      if (known[key]) this.p[key] = clean(known[key], value);
    });
  }

  frame(ctx) {
    this.clock += ctx.dt * Number(this.p.speed ?? 1);
    const rgb = this.render(ctx);
    const out = frame();
    for (let i = 0; i < out.length; i++) out[i] = clamp(Number.isFinite(rgb[i]) ? rgb[i] : 0, 0, 1);
    return out;
  }

  render() {
    throw new Error("Effects draw in render");
  }

  /** Coordinates for things drawn on the front: forward, right, up. */
  view(ctx) {
    const a = radians(Number(this.p.facing ?? 0));
    const c = Math.cos(a);
    const s = Math.sin(a);
    const forward = new Float64Array(N);
    const right = new Float64Array(N);
    const up = new Float64Array(N);
    ctx.pos.forEach(([x, y, z], i) => {
      forward[i] = x * c + y * s;
      right[i] = -x * s + y * c;
      up[i] = z;
    });
    return { forward, right, up };
  }

  static describe() {
    return { id: this.id, name: this.name, category: this.category, params: this.params.map(describe) };
  }
}

/** Adds a fading trail for anything that draws with sharp moving edges. */
class Trail extends Effect {
  constructor(geo, rng) {
    super(geo, rng);
    this.buffer = frame();
  }

  fadeTrail(ctx, decay) {
    const k = Math.exp(-ctx.dt * decay);
    for (let i = 0; i < this.buffer.length; i++) this.buffer[i] *= k;
  }
}

// Worlds

const LAND = [
  [48, -100, 27], [24, -100, 11], [64, -125, 16], [15, -86, 6],
  [-12, -58, 20], [-34, -66, 10], [6, -70, 9],
  [6, 21, 22], [24, 12, 17], [-22, 25, 12], [8, 40, 8],
  [50, 15, 12], [62, 25, 9],
  [52, 95, 30], [24, 80, 11], [24, 108, 12], [66, 110, 16], [36, 55, 10], [-2, 115, 7],
  [-25, 134, 12], [72, -40, 9],
].map(([lat, lon, radius]) => ({ at: dir(lat, lon), radius }));

/** Where the sun is directly overhead right now, as [lat, lon] in degrees. */
export function subsolarPoint(now) {
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const day = Math.floor((now.getTime() - start) / 86400000) + 1;
  const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const declination = -23.44 * Math.cos(radians((360 / 365) * (day + 10)));
  return [declination, (12 - hours) * 15];
}

/** 0 is new moon, 0.5 is full. */
export function moonPhase(now) {
  const newMoon = Date.UTC(2000, 0, 6, 18, 14);
  return mod((now.getTime() - newMoon) / 1000 / 86400 / 29.530588, 1);
}

effect(class Earth extends Effect {
  static id = "earth";
  static name = "Earth";
  static category = "Worlds";
  static params = [
    range("spin", "Spin", 1, -6, 6, 0.05),
    bool("real_sun", "Real daylight", true),
    range("night", "Night glow", 0.35, 0, 1, 0.01),
  ];

  turn = 0;

  render(ctx) {
    this.turn += ctx.dt * this.p.spin * 0.15;
    const cosT = Math.cos(this.turn);
    const sinT = Math.sin(this.turn);
    const [subLat, subLon] = this.p.real_sun ? subsolarPoint(ctx.now) : [15, degrees(ctx.t * 0.1)];
    const sun = dir(subLat, subLon);
    const out = frame();
    ctx.pos.forEach(([px, py, pz], i) => {
      const p = [px * cosT + py * sinT, -px * sinT + py * cosT, pz];
      let land = 0;
      LAND.forEach(({ at, radius }) => {
        land = Math.max(land, 1 - smooth(radius * 0.7, radius * 1.15, degrees(angle(p, at))));
      });
      const ice = smooth(62, 76, Math.abs(degrees(Math.asin(clamp(p[2], -1, 1)))));
      const latAbs = Math.abs(p[2]);
      const dry = smooth(0.15, 0.3, latAbs) * (1 - smooth(0.4, 0.6, latAbs));
      const clouds = smooth(0.2, 0.55, fbm(p[0] * 2.2 + ctx.t * 0.03, p[1] * 2.2, p[2] * 2.2, 2));
      const day = smooth(-0.12, 0.2, dot(p, sun));
      const cities = land * (1 - day) * this.p.night * (0.6 + 0.4 * noise3(p[0] * 7, p[1] * 7, p[2] * 7));
      const sea = [0, 0.14, 0.55];
      const ground = [0.08, 0.5, 0.12];
      const desert = [0.72, 0.5, 0.16];
      const dark = [0, 0.01, 0.05];
      const glow = [1, 0.65, 0.25];
      for (let c = 0; c < 3; c++) {
        let v = (ground[c] * (1 - dry) + desert[c] * dry) * land + sea[c] * (1 - land);
        v = v * (1 - ice) + ice * 0.95;
        v = v * (1 - clouds * 0.6) + clouds * 0.6;
        out[i * 3 + c] = v * (0.04 + 0.96 * day) + dark[c] * (1 - day) + cities * glow[c];
      }
    });
    return out;
  }
});

effect(class Moon extends Effect {
  static id = "moon";
  static name = "Moon";
  static category = "Worlds";
  static params = [
    bool("real_phase", "Tonight's phase", true),
    range("phase", "Phase", 0.5, 0, 1, 0.01),
    facing(),
    range("earthshine", "Earthshine", 0.06, 0, 0.3, 0.01),
  ];

  render(ctx) {
    const phase = this.p.real_phase ? moonPhase(ctx.now) : this.p.phase;
    const { forward, right } = this.view(ctx);
    const a = phase * TAU;
    const shine = this.p.earthshine;
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const lit = smooth(-0.1, 0.1, forward[i] * -Math.cos(a) + right[i] * Math.sin(a));
      const surface = clamp(0.62 + 0.38 * fbm(x * 2.6, y * 2.6, z * 2.6, 3), 0, 1);
      const k = surface * (shine + (1 - shine) * lit);
      put(out, i, k, k * 0.97, k * 0.88);
    });
    return out;
  }
});

effect(class Sun extends Effect {
  static id = "sun";
  static name = "Sun";
  static category = "Worlds";
  static params = [speed(), range("activity", "Activity", 0.5, 0, 1, 0.01)];

  render(ctx) {
    const out = frame();
    const c = this.clock;
    ctx.pos.forEach(([x, y, z], i) => {
      const heat = clamp(0.5 + 1.1 * fbm(x * 2.4, y * 2.4, z * 2.4 + c * 0.25, 3), 0, 1);
      const flare = smooth(0.62 - this.p.activity * 0.3, 0.9, 0.5 + 0.5 * noise3(x * 1.6 + c * 0.4, y * 1.6 + c * 0.4, z * 1.6 + c * 0.4));
      palettes.sample("Ember", 0.38 + 0.42 * heat + 0.25 * flare, false, out, i * 3);
    });
    return out;
  }
});

effect(class Jupiter extends Effect {
  static id = "jupiter";
  static name = "Jupiter";
  static category = "Worlds";
  static params = [speed(), bool("spot", "Red spot", true)];

  render(ctx) {
    const turn = this.clock * 0.25;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const light = [0.95, 0.82, 0.6];
    const dark = [0.55, 0.26, 0.1];
    const red = [0.85, 0.12, 0.03];
    const spotAt = dir(-22, 0);
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const p = [x * c + y * s, -x * s + y * c, z];
      const wobble = 0.12 * noise3(p[0] * 2.4, p[1] * 2.4, p[2] * 5);
      const band = 0.5 + 0.5 * Math.sin((p[2] + wobble) * 9.5);
      const spot = this.p.spot ? 1 - smooth(0.28, 0.5, angle(p, spotAt)) : 0;
      for (let k = 0; k < 3; k++) {
        const v = dark[k] + (light[k] - dark[k]) * band;
        out[i * 3 + k] = v * (1 - spot) + red[k] * spot;
      }
    });
    return out;
  }
});

effect(class Basketball extends Effect {
  static id = "basketball";
  static name = "Basketball";
  static category = "Worlds";
  static params = [range("spin", "Spin", 1, -6, 6, 0.05), range("tilt", "Tilt", 20, -90, 90, 1)];

  turn = 0;

  render(ctx) {
    this.turn += ctx.dt * this.p.spin * 0.8;
    const t = radians(this.p.tilt);
    const out = frame();
    ctx.pos.forEach(([x, py, pz], i) => {
      const y = py * Math.cos(t) - pz * Math.sin(t);
      const z = py * Math.sin(t) + pz * Math.cos(t);
      const a = x * Math.cos(this.turn) - z * Math.sin(this.turn);
      const c = x * Math.sin(this.turn) + z * Math.cos(this.turn);
      const seam = Math.min(Math.abs(y), Math.abs(a), Math.abs(Math.abs(c) - 0.62 - 0.3 * y * y));
      const k = 0.08 + 0.92 * smooth(0.02, 0.11, seam);
      put(out, i, 0.95 * k, 0.32 * k, 0.03 * k);
    });
    return out;
  }
});

effect(class Pumpkin extends Effect {
  static id = "pumpkin";
  static name = "Pumpkin";
  static category = "Worlds";
  static params = [facing(), range("flicker", "Candle flicker", 0.7, 0, 1, 0.01)];

  render(ctx) {
    const cut = nearest(this.view(ctx), [
      [-0.42, 0.4], [-0.3, 0.2], [0.42, 0.4], [0.3, 0.2], // eyes
      [0, 0.05], // nose
      [-0.7, -0.2], [-0.45, -0.45], [-0.15, -0.6], [0.15, -0.6], [0.45, -0.45], [0.7, -0.2], // grin
    ]);
    const flame = 1 - this.p.flicker * 0.55 * (0.5 + 0.5 * Math.sin(ctx.t * 13) * Math.sin(ctx.t * 7.3));
    const out = frame();
    for (let i = 0; i < N; i++) {
      if (cut[i]) put(out, i, flame, 0.82 * flame, 0.2 * flame);
      else {
        const ribs = (0.62 + 0.38 * Math.abs(Math.cos(ctx.lon[i] * 5))) * 0.5;
        put(out, i, 0.8 * ribs, 0.24 * ribs, 0.01 * ribs);
      }
    }
    return out;
  }
});

// Faces

effect(class Eye extends Effect {
  static id = "eye";
  static name = "Eye";
  static category = "Faces";
  static params = [
    facing(),
    colorParam("iris", "Iris", "#19c8ff"),
    colorParam("sclera", "White", "#c8c0b4"),
    bool("track", "Look around", true),
    range("look_x", "Look left and right", 0, -1, 1, 0.01),
    range("look_y", "Look up and down", 0, -1, 1, 0.01),
    range("pupil", "Pupil", 0.3, 0.1, 0.6, 0.01),
    bool("blink", "Blinks", true),
  ];

  gaze = [0, 0];
  target = [0, 0];
  nextLook = 0;
  nextBlink = 2;
  blinkAt = -9;

  render(ctx) {
    const { forward, right, up } = this.view(ctx);
    if (this.p.track) {
      if (ctx.t > this.nextLook) {
        this.target = [this.rng.uniform(-0.8, 0.8), this.rng.uniform(-0.8, 0.8) * 0.6];
        this.nextLook = ctx.t + this.rng.uniform(0.8, 3.2);
      }
    } else {
      this.target = [this.p.look_x, this.p.look_y];
    }
    const follow = Math.min(1, ctx.dt * 12);
    this.gaze = this.gaze.map((g, k) => g + (this.target[k] - g) * follow);
    if (this.p.blink && ctx.t > this.nextBlink) {
      this.blinkAt = ctx.t;
      this.nextBlink = ctx.t + this.rng.uniform(2, 6);
    }
    const closed = Math.max(0, 1 - Math.abs(ctx.t - this.blinkAt - 0.11) / 0.11);
    const gaze = unit([1, this.gaze[0] * 0.9, this.gaze[1] * 0.9]);
    const pupil = this.p.pupil;
    const sclera = palettes.color(this.p.sclera);
    const irisColor = palettes.color(this.p.iris);
    const skin = [0.22, 0.06, 0.04];
    const out = frame();
    for (let i = 0; i < N; i++) {
      const a = angle([forward[i], right[i], up[i]], gaze);
      const shade = 0.35 + 0.65 * smooth(-0.4, 0.5, forward[i]);
      const iris = 1 - smooth(pupil + 0.42, pupil + 0.62, a);
      const ring = 0.65 + 0.35 * Math.cos(a * 9);
      const dark = 1 - smooth(pupil * 0.9, pupil + 0.18, a);
      const lid = smooth(0, 0.25, 1 - closed * 1.05 - Math.abs(up[i]) * 0.9);
      for (let c = 0; c < 3; c++) {
        let v = sclera[c] * shade;
        v = v * (1 - iris) + irisColor[c] * ring * iris;
        v *= 1 - dark;
        out[i * 3 + c] = v * lid + skin[c] * (1 - lid);
      }
    }
    return out;
  }
});

const SMILE = [[-0.65, -0.15], [-0.4, -0.45], [-0.13, -0.6], [0.13, -0.6], [0.4, -0.45], [0.65, -0.15]];
const MOUTHS = {
  Happy: SMILE,
  Wink: SMILE,
  Sad: [[-0.5, -0.65], [-0.25, -0.4], [0.25, -0.4], [0.5, -0.65]],
  Angry: [[-0.4, -0.5], [0, -0.5], [0.4, -0.5]],
  Sleepy: [[0, -0.5]],
  Surprised: [[0, -0.45], [0, -0.7]],
};

effect(class Face extends Effect {
  static id = "face";
  static name = "Face";
  static category = "Faces";
  static params = [
    facing(),
    choice("mood", "Mood", "Happy", ["Happy", "Sad", "Surprised", "Wink", "Angry", "Sleepy"]),
    colorParam("skin", "Skin", "#ffc400"),
    colorParam("feature", "Features", "#180800"),
    range("bob", "Bob", 0.3, 0, 1, 0.01),
  ];

  render(ctx) {
    const view = this.view(ctx);
    const bob = this.p.bob;
    const dx = Math.sin(ctx.t * 0.9) * 0.1 * bob;
    const dy = Math.sin(ctx.t * 1.6) * 0.04 * bob;
    view.right = view.right.map((v) => v + dx);
    view.up = view.up.map((v) => v - dy);
    const mood = this.p.mood;
    const blink = mod(ctx.t, 4.1) < 0.14;
    const points = [];
    [-1, 1].forEach((side) => {
      const closed = blink || mood === "Sleepy" || (mood === "Wink" && side === 1);
      if (!closed) points.push([side * 0.4, 0.35]);
      if (mood === "Surprised") points.push([side * 0.4, 0.55]);
      if (mood === "Angry") points.push([side * 0.22, 0.42]);
    });
    points.push(...MOUTHS[mood]);
    const marks = nearest(view, points);
    const skin = palettes.color(this.p.skin);
    const feature = palettes.color(this.p.feature);
    const out = frame();
    for (let i = 0; i < N; i++) {
      const k = 0.55 + 0.45 * smooth(-1, 0.2, view.forward[i]);
      if (marks[i]) out.set(feature, i * 3);
      else put(out, i, skin[0] * k, skin[1] * k, skin[2] * k);
    }
    return out;
  }
});

// Ambient

effect(class Aurora extends Effect {
  static id = "aurora";
  static name = "Aurora";
  static category = "Ambient";
  static params = [speed(), palette("Aurora"), range("height", "Height", 0.3, -1, 1, 0.01)];

  render(ctx) {
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const curtain = fbm(x * 1.4, y * 1.4, this.clock * 0.25, 3);
      const band = Math.exp(-(((z - this.p.height - curtain * 0.35) / 0.42) ** 2));
      const shimmer = 0.6 + 0.4 * Math.sin(ctx.lon[i] * 7 + this.clock * 2 + curtain * 7);
      const rgb = palettes.sample(this.p.palette, 0.25 + band * 0.55 + curtain * 0.2);
      put(out, i, rgb[0] * band * shimmer, rgb[1] * band * shimmer, rgb[2] * band * shimmer);
    });
    return out;
  }
});

effect(class Nebula extends Effect {
  static id = "nebula";
  static name = "Nebula";
  static category = "Ambient";
  static params = [speed(0.6), palette("Vaporwave"), range("scale", "Scale", 1.5, 0.4, 4, 0.05)];

  render(ctx) {
    const s = this.p.scale;
    const c = this.clock;
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const warp = fbm(x * s + c * 0.1, y * s + c * 0.1, z * s + c * 0.1, 2) * 1.2;
      const field = fbm(x * s + warp, y * s + warp + c * 0.08, z * s + warp, 3);
      const rgb = palettes.sample(this.p.palette, 0.5 + field * 0.9, true);
      const k = smooth(-0.45, 0.25, field);
      put(out, i, rgb[0] * k, rgb[1] * k, rgb[2] * k);
    });
    return out;
  }
});

effect(class Plasma extends Effect {
  static id = "plasma";
  static name = "Plasma";
  static category = "Ambient";
  static params = [speed(), palette("Neon"), range("scale", "Scale", 2.5, 0.5, 8, 0.05)];

  render(ctx) {
    const s = this.p.scale;
    const t = this.clock;
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const v = Math.sin(x * s + t) + Math.sin(y * s * 0.8 - t * 1.3) + Math.sin(z * s * 1.2 + t * 0.7)
        + Math.sin((x + y + z) * s * 0.7 + t * 1.7);
      palettes.sample(this.p.palette, v * 0.125 + 0.5 + t * 0.03, true, out, i * 3);
    });
    return out;
  }
});

effect(class Lava extends Effect {
  static id = "lava";
  static name = "Lava Lamp";
  static category = "Ambient";
  static params = [speed(), palette("Lava"), range("blobs", "Blobs", 5, 2, 9, 1)];

  constructor(geo, rng) {
    super(geo, rng);
    this.seed = Array.from({ length: 9 }, () => [rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)]);
  }

  render(ctx) {
    const total = new Float64Array(N);
    const c = this.clock;
    for (let b = 0; b < Math.floor(this.p.blobs); b++) {
      const s = this.seed[b];
      const center = [0.75 * Math.sin(c * 0.21 + s[0]), 0.75 * Math.sin(c * 0.17 + s[1]), 0.75 * Math.sin(c * (0.13 + b * 0.015) + s[2])];
      ctx.pos.forEach((p, i) => {
        const d = (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 + (p[2] - center[2]) ** 2;
        total[i] += 0.22 / (d + 0.05);
      });
    }
    const mean = total.reduce((a, b) => a + b, 0) / N;
    const out = frame();
    total.forEach((v, i) => palettes.sample(this.p.palette, 0.5 + (v - mean) * 1.1, false, out, i * 3));
    return out;
  }
});

effect(class Ocean extends Effect {
  static id = "ocean";
  static name = "Deep Ocean";
  static category = "Ambient";
  static params = [speed(), palette("Ocean")];

  render(ctx) {
    const c = this.clock;
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const a = fbm(x * 2.2 + c * 0.2, y * 2.2, z * 2.2 + c * 0.12, 2);
      const b = fbm(x * 2.9, y * 2.9 - c * 0.16, z * 2.9 - c * 0.1, 2);
      const caustic = clamp(1 - Math.abs(a - b) * 3.2, 0, 1);
      const depth = 0.25 + 0.4 * smooth(-1, 1, z);
      palettes.sample(this.p.palette, depth + caustic ** 3 * 0.55, false, out, i * 3);
    });
    return out;
  }
});

effect(class Fire extends Effect {
  static id = "fire";
  static name = "Fireball";
  static category = "Ambient";
  static params = [speed(1.2), palette("Ember"), range("height", "Flame height", 0.65, 0.1, 1, 0.01)];

  render(ctx) {
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const n = fbm(x * 2.5, y * 2.5, z * 1.3 - this.clock * 1.1, 3);
      const h = (z + 1) / 2;
      palettes.sample(this.p.palette, 1.05 - h * (1.25 - this.p.height) + n * 0.45, false, out, i * 3);
    });
    return out;
  }
});

effect(class Stars extends Effect {
  static id = "stars";
  static name = "Starfield";
  static category = "Ambient";
  static params = [
    speed(),
    range("density", "Density", 0.25, 0.02, 1, 0.01),
    colorParam("tint", "Tint", "#cfe3ff"),
    colorParam("sky", "Night sky", "#02030a"),
  ];

  constructor(geo, rng) {
    super(geo, rng);
    this.v = Float64Array.from({ length: N }, () => rng.random());
  }

  render(ctx) {
    const chance = this.p.density * ctx.dt * this.p.speed * 2.5;
    const decay = Math.exp(-ctx.dt * this.p.speed * 1.3);
    const sky = palettes.color(this.p.sky);
    const tint = palettes.color(this.p.tint);
    const out = frame();
    for (let i = 0; i < N; i++) {
      this.v[i] = this.rng.random() < chance ? 1 : this.v[i] * decay;
      const k = this.v[i] * this.v[i];
      put(out, i, sky[0] + tint[0] * k, sky[1] + tint[1] * k, sky[2] + tint[2] * k);
    }
    return out;
  }
});

const MAX_STREAMS = 14;

effect(class Matrix extends Effect {
  // Streams of code falling down meridians, pole to pole.
  static id = "matrix";
  static name = "Matrix";
  static category = "Ambient";
  static FALL = 0.9; // radians per second
  static HEAD = 0.4; // about one triangle
  static params = [
    speed(),
    range("streams", "Streams", 7, 2, MAX_STREAMS, 1),
    range("trail", "Trail", 1.5, 0.4, 3, 0.05),
    colorParam("color", "Color", "#00ff41"),
    colorParam("lead", "Lead color", "#d8ffe0"),
  ];

  constructor(geo, rng) {
    super(geo, rng);
    this.lon = Array.from({ length: MAX_STREAMS }, () => rng.uniform(-Math.PI, Math.PI));
    this.head = Array.from({ length: MAX_STREAMS }, () => rng.uniform(0, Math.PI + 1.5));
    this.rate = Array.from({ length: MAX_STREAMS }, () => rng.uniform(0.7, 1.4));
    this.glyph = Float64Array.from({ length: N }, () => rng.uniform(0.35, 1));
  }

  render(ctx) {
    const dt = ctx.dt * this.p.speed;
    const trail = this.p.trail;
    for (let s = 0; s < MAX_STREAMS; s++) {
      this.head[s] += this.rate[s] * Matrix.FALL * dt;
      if (this.head[s] > Math.PI + trail) {
        this.lon[s] = this.rng.uniform(-Math.PI, Math.PI);
        this.head[s] = this.rng.uniform(-1.2, 0);
        this.rate[s] = this.rng.uniform(0.7, 1.4);
      }
    }
    for (let i = 0; i < N; i++) {
      if (this.rng.random() < 6 * dt) this.glyph[i] = this.rng.uniform(0.35, 1);
    }
    const body = palettes.color(this.p.color);
    const leadColor = palettes.color(this.p.lead);
    const out = frame();
    for (let i = 0; i < N; i++) {
      const down = Math.PI / 2 - ctx.lat[i];
      let lit = 0;
      let lead = 0;
      for (let s = 0; s < Math.floor(this.p.streams); s++) {
        const across = Math.abs(mod(ctx.lon[i] - this.lon[s] + Math.PI, TAU) - Math.PI) * Math.cos(ctx.lat[i]);
        const column = 1 - smooth(0.2, 0.4, across);
        const behind = this.head[s] - down;
        const ahead = behind < 0;
        lit = Math.max(lit, column * (ahead ? 0 : Math.exp(-Math.max(behind, 0) / (trail * 0.45))));
        lead = Math.max(lead, column * (ahead || behind > Matrix.HEAD ? 0 : 1));
      }
      const k = lit * this.glyph[i];
      for (let c = 0; c < 3; c++) out[i * 3 + c] = body[c] * k * (1 - lead) + leadColor[c] * lead;
    }
    return out;
  }
});

// Geometry

effect(class Sweep extends Effect {
  static id = "sweep";
  static name = "Sweep";
  static category = "Geometry";
  static params = [
    speed(),
    choice("direction", "Direction", SWEEP_DIRECTIONS[0], SWEEP_DIRECTIONS),
    range("width", "Width", 0.5, 0.15, 1.5, 0.01),
    colorParam("color", "Color", "#ff0000"),
    colorParam("background", "Background", "#000000"),
  ];

  passes = 0;

  render(ctx) {
    this.passes += ctx.dt * this.p.speed * SWEEP_PASSES;
    const mask = sweepMask(ctx.lat, ctx.lon, this.p.direction, this.passes, this.p.width);
    const fg = palettes.color(this.p.color);
    const bg = palettes.color(this.p.background);
    const out = frame();
    mask.forEach((m, i) => put(out, i, fg[0] * m + bg[0] * (1 - m), fg[1] * m + bg[1] * (1 - m), fg[2] * m + bg[2] * (1 - m)));
    return out;
  }
});

effect(class Scanner extends Trail {
  static id = "scanner";
  static name = "Plane Scanner";
  static category = "Geometry";
  static params = [speed(), palette("Neon"), range("width", "Width", 0.25, 0.08, 0.8, 0.01), range("trail", "Trail", 3, 0.5, 12, 0.1)];

  render(ctx) {
    const c = this.clock;
    const normal = unit([Math.sin(c * 0.61), Math.cos(c * 0.43), Math.sin(c * 0.29 + 1)]);
    this.fadeTrail(ctx, this.p.trail);
    ctx.pos.forEach((p, i) => {
      const hit = 1 - smooth(0, this.p.width, Math.abs(dot(p, normal)));
      maxInto(this.buffer, i, palettes.sample(this.p.palette, c * 0.06 + (p[2] + 1) * 0.12, true), hit);
    });
    return this.buffer;
  }
});

effect(class Comets extends Trail {
  static id = "comets";
  static name = "Comets";
  static category = "Geometry";
  static params = [speed(), palette("Rainbow"), range("count", "Count", 3, 1, 8, 1), range("trail", "Trail", 2, 0.5, 8, 0.1)];

  constructor(geo, rng) {
    super(geo, rng);
    this.axes = Array.from({ length: 8 }, () => unit(rng.normal3()));
  }

  render(ctx) {
    this.fadeTrail(ctx, this.p.trail);
    for (let k = 0; k < Math.floor(this.p.count); k++) {
      const axis = this.axes[k];
      const ref = unit(cross(axis, [0.3, 0.5, 0.8]));
      const other = cross(axis, ref);
      const a = this.clock * (1.1 + k * 0.13) + k * 2.1;
      const head = [0, 1, 2].map((c) => ref[c] * Math.cos(a) + other[c] * Math.sin(a));
      const rgb = palettes.sample(this.p.palette, k / 8 + this.clock * 0.02, true);
      ctx.pos.forEach((p, i) => maxInto(this.buffer, i, rgb, 1 - smooth(0.12, 0.42, angle(p, head))));
    }
    return this.buffer;
  }
});

effect(class Orbits extends Effect {
  static id = "orbits";
  static name = "Gyroscope";
  static category = "Geometry";
  static params = [speed(), palette("Royal"), range("rings", "Rings", 3, 1, 5, 1), range("width", "Width", 0.2, 0.08, 0.5, 0.01)];

  render(ctx) {
    const out = frame();
    for (let k = 0; k < Math.floor(this.p.rings); k++) {
      const c = this.clock * (0.6 + k * 0.23) + k * 1.9;
      const normal = unit([Math.sin(c), Math.cos(c * 0.8 + k), Math.sin(c * 0.5 + k * 2)]);
      const rgb = palettes.sample(this.p.palette, 0.3 + k / 6, true);
      ctx.pos.forEach((p, i) => maxInto(out, i, rgb, 1 - smooth(0, this.p.width, Math.abs(dot(p, normal)))));
    }
    return out;
  }
});

effect(class Spiral extends Effect {
  static id = "spiral";
  static name = "Barber Spiral";
  static category = "Geometry";
  static params = [speed(), palette("Candy"), range("arms", "Arms", 2, 1, 6, 1), range("twist", "Twist", 4, 0, 12, 0.1)];

  render(ctx) {
    const out = frame();
    ctx.pos.forEach((p, i) => {
      const phase = (ctx.lon[i] * this.p.arms) / TAU + p[2] * this.p.twist * 0.25 - this.clock * 0.4;
      palettes.sample(this.p.palette, phase, true, out, i * 3);
    });
    return out;
  }
});

effect(class Interference extends Effect {
  static id = "interference";
  static name = "Interference";
  static category = "Geometry";
  static params = [speed(), palette("Ice"), range("rings", "Rings", 3, 1, 8, 0.1)];

  render(ctx) {
    const c = this.clock * 0.35;
    const a = unit([Math.sin(c), Math.cos(c * 0.7), Math.sin(c * 0.4)]);
    const b = unit([Math.cos(c * 0.9), Math.sin(c * 1.2), Math.cos(c * 0.5)]);
    const k = this.p.rings * 2;
    const out = frame();
    ctx.pos.forEach((p, i) => {
      const wave = Math.sin(angle(p, a) * k - this.clock * 2) + Math.sin(angle(p, b) * k - this.clock * 2);
      palettes.sample(this.p.palette, wave * 0.25 + 0.5, false, out, i * 3);
    });
    return out;
  }
});

effect(class Facets extends Effect {
  // The 20 icosahedron faces, the way the lamp is actually built.
  static id = "facets";
  static name = "Polygon Dance";
  static category = "Geometry";
  static params = [speed(), palette("Neon"), range("hold", "Hold", 0.7, 0.1, 3, 0.05)];

  constructor(geo, rng) {
    super(geo, rng);
    this.colors = Float64Array.from({ length: 20 }, () => rng.random());
    this.levels = Float64Array.from({ length: 20 }, () => rng.random());
    this.next = 0;
  }

  render(ctx) {
    if (this.clock > this.next) {
      const pick = this.rng.integer(20);
      this.colors[pick] = this.rng.random();
      this.levels[pick] = 1;
      this.next = this.clock + this.p.hold * 0.25;
    }
    const decay = Math.exp(-ctx.dt * this.p.speed / Math.max(this.p.hold, 0.1));
    this.levels = this.levels.map((v) => v * decay);
    const out = frame();
    this.geo.parent.forEach((face, i) => {
      const rgb = palettes.sample(this.p.palette, this.colors[face], true);
      const k = 0.08 + 0.92 * this.levels[face];
      put(out, i, rgb[0] * k, rgb[1] * k, rgb[2] * k);
    });
    return out;
  }
});

effect(class Pentagons extends Effect {
  // Blooms from the 12 five-way corners of the icosahedron.
  static id = "pentagons";
  static name = "Pentagon Bloom";
  static category = "Geometry";
  static params = [speed(), palette("Sunset")];

  render() {
    const level = new Float64Array(N);
    this.geo.mainVertices.forEach((vertex, k) => {
      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 1.4 + k * 1.7);
      this.geo.pos.forEach((p, i) => {
        level[i] = Math.max(level[i], pulse * (1 - smooth(0.2, 0.75, angle(p, vertex))));
      });
    });
    const out = frame();
    level.forEach((v, i) => palettes.sample(this.p.palette, v, false, out, i * 3));
    return out;
  }
});

effect(class Life extends Effect {
  // A cellular automaton on the real triangle graph, three neighbors each.
  static id = "life";
  static name = "Life on a Sphere";
  static category = "Geometry";
  static params = [speed(), palette("Toxic")];

  constructor(geo, rng) {
    super(geo, rng);
    this.alive = this.seed();
    this.glow = new Float64Array(N);
    this.next = 0;
    this.seen = [];
  }

  seed() {
    return Uint8Array.from({ length: N }, () => (this.rng.random() < 0.35 ? 1 : 0));
  }

  render(ctx) {
    if (this.clock > this.next) {
      this.next = this.clock + 0.35;
      const was = this.alive;
      this.alive = Uint8Array.from(was, (on, i) => {
        const count = this.geo.neighbors[i].reduce((sum, j) => sum + was[j], 0);
        return (on && count === 1) || (!on && count >= 2 && this.rng.random() < 0.5) ? 1 : 0;
      });
      const sig = this.alive.join("");
      if (!this.alive.some((v) => v) || this.seen.includes(sig)) {
        this.alive = this.seed();
        this.seen = [];
      }
      this.seen = [...this.seen, sig].slice(-8);
    }
    const follow = Math.min(1, ctx.dt * 6);
    const out = frame();
    for (let i = 0; i < N; i++) {
      this.glow[i] += (this.alive[i] - this.glow[i]) * follow;
      const rgb = palettes.sample(this.p.palette, this.glow[i] * 0.9);
      put(out, i, rgb[0] * this.glow[i], rgb[1] * this.glow[i], rgb[2] * this.glow[i]);
    }
    return out;
  }
});

effect(class Snake extends Trail {
  static id = "snake";
  static name = "Snake";
  static category = "Geometry";
  static params = [speed(1.5), palette("Neon"), range("length", "Length", 10, 3, 40, 1)];

  path = [0];
  next = 0;
  hue = 0;

  render() {
    if (this.clock > this.next) {
      this.next = this.clock + 0.11;
      const options = this.geo.neighbors[this.path[this.path.length - 1]].filter((n) => !this.path.includes(n));
      const step = options.length ? options[this.rng.integer(options.length)] : this.rng.integer(N);
      this.path = [...this.path, step].slice(-Math.floor(this.p.length));
      this.hue += 0.012;
    }
    const out = frame();
    this.path.forEach((led, i) => {
      const k = (i + 1) / this.path.length;
      const rgb = palettes.sample(this.p.palette, this.hue + k * 0.2, true);
      put(out, led, rgb[0] * k * k, rgb[1] * k * k, rgb[2] * k * k);
    });
    return out;
  }
});

effect(class Ripple extends Effect {
  static id = "ripple";
  static name = "Raindrops";
  static category = "Geometry";
  static params = [speed(), palette("Ocean"), range("rate", "Rate", 1, 0.1, 5, 0.05)];

  drops = [];
  next = 0;

  render(ctx) {
    if (this.clock > this.next) {
      this.drops.push([unit(this.rng.normal3()), this.clock]);
      this.next = this.clock + this.rng.exponential(1 / this.p.rate);
    }
    this.drops = this.drops.filter(([, born]) => this.clock - born < 2.2).slice(-10);
    const out = frame();
    ctx.pos.forEach((p, i) => {
      let total = 0;
      this.drops.forEach(([origin, born]) => {
        const age = this.clock - born;
        total += Math.exp(-(((angle(p, origin) - age * 1.6) / 0.28) ** 2)) * (1 - age / 2.2);
      });
      palettes.sample(this.p.palette, 0.1 + total * 0.85, false, out, i * 3);
    });
    return out;
  }
});

effect(class Disco extends Effect {
  static id = "disco";
  static name = "Disco Ball";
  static category = "Geometry";
  static params = [speed(), range("spots", "Spots", 6, 1, 12, 1), colorParam("tint", "Base", "#0a0a12")];

  constructor(geo, rng) {
    super(geo, rng);
    this.colors = Array.from({ length: 12 }, () => rng.random());
    this.offsets = Array.from({ length: 12 }, () => [rng.uniform(0, 100), rng.uniform(0, 100)]);
  }

  render(ctx) {
    const out = fill(palettes.color(this.p.tint));
    for (let k = 0; k < Math.floor(this.p.spots); k++) {
      const [a, b] = this.offsets[k];
      const head = dir(50 * Math.sin(this.clock * 0.3 + a), this.clock * 40 + b * 3.6);
      const rgb = palettes.sample("Rainbow", this.colors[k], true);
      ctx.pos.forEach((p, i) => maxInto(out, i, rgb, 1 - smooth(0.2, 0.5, angle(p, head))));
    }
    return out;
  }
});

// Music

effect(class Spectrum extends Effect {
  static id = "spectrum";
  static name = "Spectrum Globe";
  static category = "Music";
  static params = [palette("Rainbow"), range("gain", "Gain", 1, 0.2, 3, 0.05)];

  render(ctx) {
    const bins = ctx.audio.bins;
    const out = frame();
    ctx.pos.forEach((p, i) => {
      const height = ((p[2] + 1) / 2) * 15;
      const low = clamp(Math.floor(height), 0, 14);
      const frac = height - low;
      const value = bins[low] * (1 - frac) + bins[low + 1] * frac;
      const k = clamp(value * this.p.gain, 0.03, 1);
      const rgb = palettes.sample(this.p.palette, (height / 15) * 0.85);
      put(out, i, rgb[0] * k, rgb[1] * k, rgb[2] * k);
    });
    return out;
  }
});

effect(class EqPillars extends Effect {
  static id = "eq_pillars";
  static name = "Equalizer Crown";
  static category = "Music";
  static params = [palette("Neon"), range("gain", "Gain", 1, 0.2, 3, 0.05)];

  render(ctx) {
    const out = frame();
    ctx.pos.forEach((p, i) => {
      const index = Math.floor(((ctx.lon[i] + Math.PI) / TAU) * 16) % 16;
      const level = clamp(ctx.audio.bins[index] * this.p.gain, 0, 1);
      const up = (p[2] + 1) / 2;
      const k = smooth(0, 0.15, level - up + 0.05) * 0.97 + 0.03;
      const rgb = palettes.sample(this.p.palette, up);
      put(out, i, rgb[0] * k, rgb[1] * k, rgb[2] * k);
    });
    return out;
  }
});

effect(class BeatRipple extends Effect {
  static id = "beat_ripple";
  static name = "Beat Shockwave";
  static category = "Music";
  static params = [palette("Sunset"), range("speed", "Wave speed", 2.2, 0.5, 5, 0.05)];

  waves = [];
  armed = true;

  render(ctx) {
    const audio = ctx.audio;
    if (audio.beat > 0.8 && this.armed) {
      this.waves.push([unit(this.rng.normal3()), ctx.t]);
      this.armed = false;
    }
    if (audio.beat < 0.5) this.armed = true;
    this.waves = this.waves.filter(([, born]) => ctx.t - born < 1.6).slice(-6);
    const out = frame();
    ctx.pos.forEach((p, i) => {
      let total = audio.level * 0.12;
      this.waves.forEach(([origin, born]) => {
        const age = ctx.t - born;
        total += Math.exp(-(((angle(p, origin) - age * this.p.speed) / 0.35) ** 2)) * (1 - age / 1.6);
      });
      palettes.sample(this.p.palette, clamp(total, 0, 1), false, out, i * 3);
    });
    return out;
  }
});

effect(class Core extends Effect {
  static id = "core";
  static name = "Reactor Core";
  static category = "Music";
  static params = [palette("Ember"), range("gain", "Gain", 1, 0.2, 3, 0.05)];

  render(ctx) {
    const audio = ctx.audio;
    const spin = ctx.t * (0.4 + audio.mid) * 0.4;
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const n = fbm(x * 2 + spin, y * 2 + spin, z * 2 + spin, 2);
      const energy = clamp(audio.bass * this.p.gain * 0.9 + audio.beat * 0.25 + n * 0.25 + 0.08, 0, 1);
      palettes.sample(this.p.palette, energy, false, out, i * 3);
      if (this.rng.random() < audio.treble * 0.14) put(out, i, 1, 1, 1);
    });
    return out;
  }
});

// Data

effect(class Clock extends Effect {
  static id = "clock";
  static name = "Globe Clock";
  static category = "Data";
  static params = [
    facing(),
    colorParam("hour", "Hour", "#ff7a18"),
    colorParam("minute", "Minute", "#19c8ff"),
    colorParam("second", "Second", "#ffffff"),
    colorParam("base", "Base", "#141a2c"),
  ];

  render(ctx) {
    // The browser knows the viewer's time zone, so the hands show local time.
    const now = ctx.now;
    const hour = ((now.getHours() % 12) + now.getMinutes() / 60) / 12;
    const minute = (now.getMinutes() + now.getSeconds() / 60) / 60;
    const second = (now.getSeconds() + now.getMilliseconds() / 1000) / 60;
    const out = fill(palettes.color(this.p.base));
    [[second, -50, 0.3, "second"], [minute, 8, 0.42, "minute"], [hour, 55, 0.55, "hour"]].forEach(([frac, lat, width, key]) => {
      const head = dir(lat, this.p.facing - frac * 360);
      const rgb = palettes.color(this.p[key]);
      ctx.pos.forEach((p, i) => maxInto(out, i, rgb, 1 - smooth(width * 0.4, width, angle(p, head))));
    });
    return out;
  }
});

effect(class Gauge extends Effect {
  // Fills the sphere like a tank from any Home Assistant number.
  static id = "gauge";
  static name = "Tank Gauge";
  static category = "Data";
  static params = [
    param("entity", "Sensor", "entity", ""),
    range("low", "Empty at", 0, -1000, 10000, 1),
    range("high", "Full at", 100, -1000, 10000, 1),
    range("value", "Level with no sensor", 0.6, 0, 1, 0.01),
    palette("Toxic"),
    range("slosh", "Slosh", 0.5, 0, 1, 0.01),
  ];

  render(ctx) {
    let level = this.p.value;
    const state = this.p.entity ? ctx.stateOf(this.p.entity) : null;
    if (state) {
      const reading = parseFloat(state[0]);
      if (Number.isFinite(reading)) level = (reading - this.p.low) / (this.p.high - this.p.low || 1);
    }
    level = clamp(level, 0, 1);
    const slosh = this.p.slosh;
    const surface = level * 2 - 1;
    const tone = palettes.sample(this.p.palette, level);
    const out = frame();
    ctx.pos.forEach(([x, y, z], i) => {
      const tilt = Math.sin(ctx.t * 1.3) * x * 0.1 * slosh + Math.cos(ctx.t * 0.9) * y * 0.1 * slosh;
      const full = 1 - smooth(-0.1, 0.1, z + tilt - surface);
      put(out, i, tone[0] * full + 0.012 * (1 - full), tone[1] * full + 0.012 * (1 - full), tone[2] * full + 0.02 * (1 - full));
    });
    return out;
  }
});

const WEATHER = {
  sunny: "sun", "clear-night": "stars", partlycloudy: "cloud", cloudy: "cloud",
  fog: "fog", rainy: "rain", pouring: "rain", lightning: "storm",
  "lightning-rainy": "storm", snowy: "snow", "snowy-rainy": "snow", windy: "cloud", hail: "snow",
};

effect(class Weather extends Effect {
  // Shows the sky outside from a Home Assistant weather entity.
  static id = "weather";
  static name = "Weather Window";
  static category = "Data";
  static params = [
    param("entity", "Weather", "entity", ""),
    choice("preview", "Sky with no entity", "sun", ["sun", "cloud", "rain", "snow", "storm", "fog", "stars"]),
  ];

  constructor(geo, rng) {
    super(geo, rng);
    this.drops = Float64Array.from({ length: N }, () => rng.random());
    this.flash = 0;
  }

  render(ctx) {
    let kind = this.p.preview;
    const state = this.p.entity ? ctx.stateOf(this.p.entity) : null;
    if (state) kind = WEATHER[state[0]] || "cloud";
    const out = frame();
    if (kind === "sun") {
      const sunAt = dir(45, ctx.t * 6);
      ctx.pos.forEach((p, i) => {
        const sky = 0.55 + (0.45 * (p[2] + 1)) / 2;
        const sun = 1 - smooth(0.25, 0.7, angle(p, sunAt));
        put(out, i, 0.1 * sky * (1 - sun) + sun, 0.38 * sky * (1 - sun) + 0.9 * sun, 0.95 * sky * (1 - sun) + 0.5 * sun);
      });
      return out;
    }
    if (kind === "stars") {
      for (let i = 0; i < N; i++) {
        const twinkle = this.rng.random() < 0.1 ? 0.5 : 0;
        put(out, i, 0.005 + twinkle, 0.01 + twinkle, 0.05 + twinkle);
      }
      return out;
    }
    const snow = kind === "snow";
    if (!(kind === "fog" || kind === "cloud")) {
      this.drops = this.drops.map((d) => mod(d + ctx.dt * (snow ? 0.6 : 2), 1));
      if (kind === "storm") {
        if (this.rng.random() < ctx.dt * 0.4) this.flash = 1;
        this.flash *= Math.exp(-ctx.dt * 7);
      }
    }
    ctx.pos.forEach(([x, y, z], i) => {
      const cover = smooth(-0.3, 0.3, fbm(x * 2 + ctx.t * 0.08, y * 2, z * 2, 3));
      if (kind === "fog" || kind === "cloud") {
        const grey = kind === "cloud" ? [0.42, 0.45, 0.5] : [0.28, 0.3, 0.3];
        const blue = kind === "cloud" ? [0.1, 0.28, 0.6] : grey.map((v) => v * 0.7);
        put(out, i, ...grey.map((g, c) => g * cover + blue[c] * (1 - cover)));
        return;
      }
      const streak = Math.exp(-(((this.drops[i] - (1 - (z + 1) / 2)) * (snow ? 6 : 9)) ** 2));
      const tint = snow ? [0.8, 0.85, 1] : [0.2, 0.5, 1];
      const flash = kind === "storm" ? this.flash : 0;
      const base = [0.03, 0.05, 0.1];
      put(out, i, ...base.map((b, c) => b + cover * 0.08 + streak * tint[c] * 0.8 + flash));
    });
    return out;
  }
});

effect(class Picture extends Effect {
  // Wraps a world-map style image around the sphere.
  static id = "picture";
  static name = "Picture Wrap";
  static category = "Data";
  static params = [range("spin", "Spin", 0.5, -6, 6, 0.05), param("source", "Image path or URL", "text", "")];

  image = null;
  turn = 0;

  render(ctx) {
    this.turn += ctx.dt * this.p.spin * 0.3;
    if (!this.image) return fill([0.05, 0.05, 0.07]);
    const { width, height, data } = this.image;
    const out = frame();
    for (let i = 0; i < N; i++) {
      const u = mod((ctx.lon[i] + this.turn) / TAU + 0.5, 1);
      const v = 0.5 - ctx.lat[i] / Math.PI;
      const row = Math.min(Math.floor(v * height), height - 1);
      const col = Math.min(Math.floor(u * width), width - 1);
      const at = (row * width + col) * 4;
      put(out, i, data[at] / 255, data[at + 1] / 255, data[at + 2] / 255);
    }
    return out;
  }
});

// Basics

effect(class Solid extends Effect {
  static id = "solid";
  static name = "Solid";
  static category = "Basics";
  static params = [colorParam("color", "Color", "#ff7a18")];

  render() {
    return fill(palettes.color(this.p.color));
  }
});

effect(class Gradient extends Effect {
  static id = "gradient";
  static name = "Pole to Pole";
  static category = "Basics";
  static params = [colorParam("top", "Top", "#ff4d6d"), colorParam("bottom", "Bottom", "#2b2bff"), speed(0)];

  render(ctx) {
    const top = palettes.color(this.p.top);
    const bottom = palettes.color(this.p.bottom);
    const out = frame();
    ctx.pos.forEach((p, i) => {
      const k = clamp((p[2] + 1) / 2 + Math.sin(this.clock + ctx.lon[i]) * 0.08, 0, 1);
      put(out, i, ...top.map((t, c) => t * k + bottom[c] * (1 - k)));
    });
    return out;
  }
});

effect(class Calibrate extends Effect {
  // Red top, green toward the front, blue to the right. Used to line up the model.
  static id = "calibrate";
  static name = "Line Up";
  static category = "Basics";

  render(ctx) {
    const out = fill([0.015, 0.015, 0.015]);
    ctx.pos.forEach(([x, y, z], i) => {
      if (z > 0.75) put(out, i, 1, 0, 0);
      if (x > 0.75) put(out, i, 0, 1, 0);
      if (y > 0.75) put(out, i, 0, 0, 1);
    });
    return out;
  }
});
