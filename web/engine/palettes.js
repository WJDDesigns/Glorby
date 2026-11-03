// Gradient palettes, sampled into 256-entry tables. A copy of core/palettes.py.

export const STOPS = {
  Aurora: ["#031a2b", "#0b6e4f", "#21d59b", "#7cf5c6", "#7b3fe4", "#150a3a"],
  Ember: ["#000000", "#3a0500", "#a31400", "#ff5a00", "#ffb300", "#fff2b0"],
  Ocean: ["#00061a", "#002a5c", "#00639b", "#00a6c7", "#6fe7dd", "#e6fffa"],
  Sunset: ["#1b0b3b", "#5a1a77", "#c2185b", "#ff5e3a", "#ffb347", "#ffe29f"],
  Neon: ["#ff00a8", "#7a00ff", "#00c8ff", "#00ffb3", "#fff000", "#ff00a8"],
  Rainbow: ["#ff0000", "#ffb000", "#b0ff00", "#00ff40", "#00ffff", "#0040ff", "#b000ff", "#ff0000"],
  Ice: ["#000814", "#023e8a", "#0096c7", "#90e0ef", "#ffffff"],
  Forest: ["#02120a", "#0b3d20", "#2d6a4f", "#74c69d", "#d8f3dc"],
  Lava: ["#000000", "#240000", "#8a0000", "#ff2a00", "#ff9500", "#ffe600"],
  Vaporwave: ["#2d00f7", "#8900f2", "#e500a4", "#ff5c8a", "#00e5ff", "#2d00f7"],
  Royal: ["#07041f", "#2a0a6b", "#6a1fd0", "#d4a017", "#fff0b3"],
  Candy: ["#ff5fa2", "#ffd166", "#7cf29c", "#6ecbff", "#c58bff", "#ff5fa2"],
  Mono: ["#000000", "#ffffff"],
  Blood: ["#000000", "#300000", "#b00000", "#ff1a1a"],
  Toxic: ["#001200", "#00471b", "#39d353", "#c6ff00", "#f4ffb0"],
  Halloween: ["#120016", "#4b0082", "#ff6a00", "#ffae00", "#3dff00"],
};

export const NAMES = Object.keys(STOPS);

/** Turn "#rrggbb" into [r, g, b] floats. */
export function color(value) {
  const hex = String(value).replace(/^#/, "");
  return [0, 2, 4].map((i) => (parseInt(hex.slice(i, i + 2), 16) || 0) / 255);
}

function table(stops) {
  const colors = stops.map(color);
  const out = new Float64Array(256 * 3);
  const last = colors.length - 1;
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * last;
    const low = Math.min(Math.floor(x), last - 1);
    const frac = x - low;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = colors[low][c] * (1 - frac) + colors[low + 1][c] * frac;
  }
  return out;
}

const TABLES = Object.fromEntries(NAMES.map((name) => [name, table(STOPS[name])]));

/** Look t (0..1) up in a palette. Writes into out at offset, or returns a new [r, g, b]. */
export function sample(name, t, wrap = false, out = null, offset = 0) {
  const tab = TABLES[name] || TABLES.Aurora;
  t = wrap ? t - Math.floor(t) : Math.min(1, Math.max(0, t));
  if (!Number.isFinite(t)) t = 0;
  const pos = t * 255;
  const low = Math.floor(pos);
  const high = Math.min(low + 1, 255);
  const frac = pos - low;
  const target = out || [0, 0, 0];
  for (let c = 0; c < 3; c++) target[offset + c] = tab[low * 3 + c] * (1 - frac) + tab[high * 3 + c] * frac;
  return target;
}
