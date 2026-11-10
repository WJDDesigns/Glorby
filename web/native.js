// Effects the lamp can run by itself. Glorby firmware carries some of the effects as native
// WLED effects ("Glorby Sweep"), so those keep playing after the page closes or the computer
// sleeps. Everything else is still drawn here and streamed to the lamp.
//
// Each entry names the firmware effect and says which WLED slider carries each setting.
// A [key, min, max] slider maps the setting's min..max linearly onto 0..255.

import { SWEEP_DIRECTIONS } from "./engine/sphere.js";

const EFFECTS = {
  sweep: { name: "Sweep", ix: ["width", 0.15, 1.5], c1: "direction", col: ["color", "background"] },
  scanner: { name: "Plane Scanner", ix: ["width", 0.08, 0.8], c1: ["trail", 0.5, 12], pal: true },
  comets: { name: "Comets", ix: ["trail", 0.5, 8], c1: ["count", 1, 8], pal: true },
  orbits: { name: "Gyroscope", ix: ["width", 0.08, 0.5], c1: ["rings", 1, 5], pal: true },
  spiral: { name: "Barber Spiral", ix: ["twist", 0, 12], c1: ["arms", 1, 6], pal: true },
  interference: { name: "Interference", ix: ["rings", 1, 8], pal: true },
  facets: { name: "Polygon Dance", ix: ["hold", 0.1, 3], pal: true },
  pentagons: { name: "Pentagon Bloom", pal: true },
  life: { name: "Life on a Sphere", pal: true },
  snake: { name: "Snake", ix: ["length", 3, 40], pal: true },
  ripple: { name: "Raindrops", ix: ["rate", 0.1, 5], pal: true },
  disco: { name: "Disco Ball", c1: ["spots", 1, 12], col: [null, "tint"] },
};

const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));

function slider(spec, params) {
  if (spec === "direction") return byte(Math.max(0, SWEEP_DIRECTIONS.indexOf(params.direction)) * 52);
  const [key, min, max] = spec;
  const value = Number(params[key]);
  return byte(Number.isFinite(value) ? ((value - min) / (max - min)) * 255 : 128);
}

function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** What this lamp's firmware can run itself: effect and palette ids by name. Empty on other firmware. */
export function nativeCatalog(effects = [], palettes = []) {
  const fx = {};
  const pal = {};
  effects.forEach((name, id) => {
    const m = /^Glorby (.+)$/.exec(String(name));
    if (m) fx[m[1]] = id;
  });
  palettes.forEach((name, id) => {
    const m = /^Glorby: (.+)$/.exec(String(name));
    if (m) pal[m[1]] = id;
  });
  return { fx, pal };
}

/**
 * The segment settings that make the lamp run this effect itself, or null when it can't.
 * The page-wide adjustments (spin, tumble, hue, saturation) only exist here, so an effect
 * using them is still streamed.
 */
export function nativeSegment(catalog, effect, params = {}, globals = {}) {
  const spec = EFFECTS[effect];
  const id = spec && catalog?.fx[spec.name];
  if (id === undefined || !spec) return null;
  if (globals.spin || globals.tumble || globals.hue || (globals.saturation ?? 1) !== 1) return null;
  const seg = { fx: id, sx: byte(Number(params.speed ?? 1) * 64), frz: false };
  if (spec.ix) seg.ix = slider(spec.ix, params);
  if (spec.c1) seg.c1 = slider(spec.c1, params);
  if (spec.col) seg.col = [spec.col[0] ? rgb(params[spec.col[0]]) : [255, 255, 255], rgb(params[spec.col[1]]), [0, 0, 0]];
  if (spec.pal && catalog.pal[params.palette] !== undefined) seg.pal = catalog.pal[params.palette];
  return seg;
}
