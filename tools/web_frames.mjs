// Prints what the web app's engine draws, for tools/check_web_effects.py to compare.
// Reads a JSON job on stdin: { now, steps, dt, audio, runs: [{ effect, params, globals }] }.
import { readFileSync } from "node:fs";
import { Engine, engineCatalog } from "../web/engine/engine.js";
import { seeded } from "../web/engine/sphere.js";

const job = JSON.parse(readFileSync(0, "utf8"));
const map = JSON.parse(readFileSync(new URL("../web/lamp-map.json", import.meta.url), "utf8"));
const frames = job.runs.map((run) => {
  const engine = new Engine(map, { random: seeded(7) });
  engine.now = () => new Date(job.now);
  if (job.audio) Object.assign(engine.audio, job.audio, { bins: Float64Array.from(job.audio.bins) });
  engine.setGlobals(run.globals || {});
  engine.play(run.effect, run.params || {});
  let display;
  for (let i = 0; i < job.steps; i++) display = engine.step(job.dt);
  return Array.from(display);
});
process.stdout.write(JSON.stringify({ catalog: engineCatalog(), frames }));
