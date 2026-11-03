// Shared math for effects: the lamp's layout, noise and small vector helpers.
// A copy of the helpers in core/effects.py and core/geometry.py.

export const LED_COUNT = 80;
export const CELLS = 120;
export const TAU = Math.PI * 2;

/** Python's %, which never goes negative for a positive divisor. */
export const mod = (a, b) => ((a % b) + b) % b;
export const clamp = (x, low, high) => Math.min(high, Math.max(low, x));

export function smooth(low, high, x) {
  const t = clamp((x - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const angle = (p, d) => Math.acos(clamp(dot(p, d), -1, 1));
export const degrees = (r) => (r * 180) / Math.PI;
export const radians = (d) => (d * Math.PI) / 180;

export function unit(v) {
  const n = Math.max(Math.hypot(v[0], v[1], v[2]), 1e-9);
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** A direction from latitude and longitude in degrees. */
export function dir(latDeg, lonDeg) {
  const la = radians(latDeg);
  const lo = radians(lonDeg);
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/** Random numbers in the shapes effects ask for. */
export class Random {
  constructor(source = Math.random) {
    this.random = source;
  }

  uniform(low = 0, high = 1) {
    return low + (high - low) * this.random();
  }

  normal() {
    const u = 1 - this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * this.random());
  }

  normal3() {
    return [this.normal(), this.normal(), this.normal()];
  }

  integer(n) {
    return Math.floor(this.random() * n);
  }

  exponential(scale) {
    return -Math.log(1 - this.random()) * scale;
  }
}

/** A small seeded generator, so tests can repeat a run. */
export function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gradient noise. The tables come from the integration through lamp-map.json, so
// the same effect looks the same whichever app runs it.
let PERM = new Int32Array(768);
let GRAD = new Float64Array(768);

export function setNoise({ perm, grad }) {
  PERM = new Int32Array(768);
  for (let i = 0; i < 768; i++) PERM[i] = perm[i % 256];
  GRAD = new Float64Array(grad.flat());
}

const fade = (f) => f * f * f * (f * (f * 6 - 15) + 10);

/** Gradient noise, roughly -1..1. */
export function noise3(x, y, z) {
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  const fz0 = Math.floor(z);
  const fx = x - fx0;
  const fy = y - fy0;
  const fz = z - fz0;
  const ux = fade(fx);
  const uy = fade(fy);
  const uz = fade(fz);
  const cx = fx0 & 255;
  const cy = fy0 & 255;
  const cz = fz0 & 255;
  let out = 0;
  for (let dx = 0; dx < 2; dx++) {
    const wx = dx ? ux : 1 - ux;
    for (let dy = 0; dy < 2; dy++) {
      const wy = dy ? uy : 1 - uy;
      for (let dz = 0; dz < 2; dz++) {
        const wz = dz ? uz : 1 - uz;
        const h = PERM[PERM[PERM[cx + dx] + cy + dy] + cz + dz] % 256;
        const g = h * 3;
        out += wx * wy * wz * (GRAD[g] * (fx - dx) + GRAD[g + 1] * (fy - dy) + GRAD[g + 2] * (fz - dz));
      }
    }
  }
  return out * 1.9;
}

export function fbm(x, y, z, octaves = 3) {
  let total = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += noise3(x, y, z) * amp;
    norm += amp;
    amp *= 0.5;
    x = x * 2.03 + 11.7;
    y = y * 2.03 + 11.7;
    z = z * 2.03 + 11.7;
  }
  return total / norm;
}

/** Everything effects look up per LED, built from the model in lamp-map.json. */
export function buildGeometry(map) {
  const { vertices, faces, cells, parent } = map;
  const pos = faces.map((face) => unit([0, 1, 2].map((axis) => face.reduce((sum, v) => sum + vertices[v][axis], 0) / 3)));
  const neighbors = faces.map((face, i) => {
    const mine = new Set(face);
    const shared = [];
    faces.forEach((other, j) => {
      if (j !== i && other.filter((v) => mine.has(v)).length === 2) shared.push(j);
    });
    return shared;
  });
  return {
    vertices,
    faces,
    cells,
    parent: parent || faces.map((_, i) => Math.floor(i / 4)),
    pos,
    lat: Float64Array.from(pos, (p) => Math.asin(clamp(p[2], -1, 1))),
    lon: Float64Array.from(pos, (p) => Math.atan2(p[1], p[0])),
    neighbors,
    mainVertices: vertices.slice(0, 12),
  };
}

export const SWEEP_DIRECTIONS = ["Up and down", "Up", "Down", "Left", "Right"];
export const SWEEP_PASSES = 0.6; // per second at speed 1

/** A soft band crossing the sphere, after this many passes have gone by. */
export function sweepMask(lat, lon, direction, passes, width) {
  const out = new Float64Array(lat.length);
  for (let i = 0; i < lat.length; i++) {
    let off;
    if (direction === "Left" || direction === "Right") {
      const center = TAU * mod(passes, 1) * (direction === "Right" ? 1 : -1);
      off = mod(lon[i] - center + Math.PI, TAU) - Math.PI;
    } else if (direction === "Up and down") {
      const bounce = mod(passes, 2);
      off = lat[i] - (Math.min(bounce, 2 - bounce) * Math.PI - Math.PI / 2);
    } else {
      // Start and finish fully off the sphere, so each pass leaves it clear.
      const margin = width * 1.5;
      const center = mod(passes, 1) * (Math.PI + 2 * margin) - Math.PI / 2 - margin;
      off = lat[i] - (direction === "Up" ? center : -center);
    }
    out[i] = Math.exp(-((off / width) ** 2));
  }
  return out;
}
