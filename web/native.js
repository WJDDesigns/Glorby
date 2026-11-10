// Effects the lamp can run by itself. Glorby firmware carries Glorby's effects as native WLED
// effects ("Glorby Sweep"), so they keep playing after the page closes or the computer sleeps.
// Anything the firmware doesn't have is still drawn here and streamed to the lamp.
//
// Each native effect's metadata (from /json/fxdata) labels its sliders, colours and palette,
// and the labels are the web effect's own setting names, so settings are matched by name.
// Speed ("!" on the first slider) is 64 per 1x. Other ranges map linearly from the setting's
// min..max onto the slider, a choice sits in the middle of its share of the slider, and a
// tick box is a WLED option.

import { REGISTRY } from "./engine/effects.js";

const SLOTS = ["sx", "ix", "c1", "c2", "c3", "o1", "o2", "o3"];

const byte = (value, top = 255) => Math.max(0, Math.min(top, Math.round(value)));
const plain = (text) => String(text || "").toLowerCase().replace(/\//g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The setting a firmware label names: the same name, or one that starts with it ("Level with no sensor"). */
function settingFor(params, label) {
  const want = plain(label);
  if (!want) return null;
  return params.find((p) => plain(p.name) === want) || params.find((p) => plain(p.name).startsWith(`${want} `)) || null;
}

/** What this lamp's firmware runs itself: effects (with their labels) and palettes, by name. Empty on other firmware. */
export function nativeCatalog(effects = [], fxdata = [], palettes = []) {
  const fx = {};
  const pal = {};
  effects.forEach((name, id) => {
    const m = /^Glorby (.+)$/.exec(String(name));
    if (!m) return;
    // WLED lists the metadata without the name; some builds keep it.
    const meta = String(fxdata[id] || "").replace(/^[^@]*@/, "");
    const [sliders = "", colors = "", palette = ""] = meta.split(";");
    fx[m[1]] = { id, sliders: sliders.split(","), colors: colors.split(","), palette: palette.trim() !== "" };
  });
  palettes.forEach((name, id) => {
    const m = /^Glorby: (.+)$/.exec(String(name));
    if (m) pal[m[1]] = id;
  });
  return { fx, pal };
}

/**
 * The segment settings that make the lamp run this effect itself, or null when it can't.
 * The page-wide adjustments (spin, tumble, hue, saturation) and Home Assistant sensors only
 * exist here, so an effect using them is still streamed.
 */
export function nativeSegment(catalog, effect, params = {}, globals = {}) {
  const fx = REGISTRY[effect];
  const entry = fx && catalog?.fx[fx.name];
  if (!entry) return null;
  if (globals.spin || globals.tumble || globals.hue || (globals.saturation ?? 1) !== 1) return null;
  const specs = fx.params || [];
  const value = (p) => params[p.key] ?? p.default;
  if (specs.some((p) => p.kind === "entity" && value(p))) return null;

  const seg = { fx: entry.id, frz: false };
  entry.sliders.forEach((label, i) => {
    const key = SLOTS[i];
    if (!key) return;
    if (i === 0 && label.trim() === "!") {
      seg.sx = byte(Number(params.speed ?? specs.find((p) => p.key === "speed")?.default ?? 1) * 64);
      return;
    }
    const p = settingFor(specs, label);
    if (!p) return;
    const v = value(p);
    const top = key === "c3" ? 31 : 255;
    if (key.startsWith("o")) seg[key] = !!v;
    else if (p.kind === "choice") {
      const options = p.options || [];
      const at = Math.max(0, options.indexOf(v));
      seg[key] = byte(((at + 0.5) * (top + 1)) / Math.max(1, options.length), top);
    } else if (p.kind === "range") {
      const n = Number(v);
      seg[key] = byte(Number.isFinite(n) && p.max > p.min ? ((n - p.min) / (p.max - p.min)) * top : top / 2, top);
    }
  });
  if (entry.colors.some((label) => label.trim())) {
    seg.col = [0, 1, 2].map((i) => {
      const p = settingFor(specs, entry.colors[i]);
      return (p && rgb(value(p))) || (i === 0 ? [255, 255, 255] : [0, 0, 0]);
    });
  }
  if (entry.palette) {
    const p = specs.find((s) => s.key === "palette");
    if (p && catalog.pal[value(p)] !== undefined) seg.pal = catalog.pal[value(p)];
  }
  return seg;
}
