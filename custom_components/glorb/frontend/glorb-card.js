// The Glorb studio: a live 3D model of the lamp and every control for it.
// Plain WebGL2 and custom elements, so it loads instantly and needs no build step.

const VS = `#version 300 es
in vec3 aPos; in vec3 aBary; in float aFace;
uniform mat4 uView; uniform float uAspect;
out vec3 vBary; out vec3 vNormal; flat out int vFace;
void main() {
  vBary = aBary; vFace = int(aFace); vNormal = mat3(uView) * normalize(aPos);
  vec4 p = uView * vec4(aPos, 1.0);
  float d = 3.1 - p.z;
  gl_Position = vec4(p.x * 2.5 / uAspect, p.y * 2.5, p.z * 0.1 * d, d);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vBary; in vec3 vNormal; flat in int vFace;
uniform sampler2D uColors; uniform float uLevel;
out vec4 color;
void main() {
  vec3 led = texelFetch(uColors, ivec2(vFace, 0), 0).rgb;
  float edge = min(vBary.x, min(vBary.y, vBary.z)) * 3.0;
  float seam = smoothstep(0.0, 0.07, edge);
  float hot = 0.7 + 0.3 * sqrt(27.0 * vBary.x * vBary.y * vBary.z);
  vec3 n = normalize(vNormal);
  float facing = clamp(n.z, 0.0, 1.0);
  vec3 shell = vec3(0.075, 0.08, 0.095) * (0.25 + 0.75 * clamp(dot(n, normalize(vec3(-0.4, 0.7, 0.6))), 0.0, 1.0));
  vec3 lit = led * uLevel * hot * (0.72 + 0.28 * facing);
  color = vec4(mix(vec3(0.012), shell + lit, seam), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

class Sphere {
  constructor(canvas, geometry) {
    this.canvas = canvas;
    this.yaw = -0.55;
    this.pitch = 0.32;
    this.autoSpin = true;
    this.level = 1;
    this.dragging = false;
    this.pixels = new Uint8Array(80 * 4);
    this.gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!this.gl) return;
    this._build(geometry);
    this._bindPointer();
    this._loop = (t) => this._draw(t);
    this.raf = requestAnimationFrame(this._loop);
  }

  _build(geometry) {
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    gl.useProgram(program);
    this.program = program;
    this.uView = gl.getUniformLocation(program, "uView");
    this.uAspect = gl.getUniformLocation(program, "uAspect");
    this.uLevel = gl.getUniformLocation(program, "uLevel");
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer();
    this.setGeometry(geometry);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.enable(gl.DEPTH_TEST);
    this.dirty = true;
  }

  setGeometry({ vertices, faces }) {
    const gl = this.gl;
    if (!gl) return;
    const data = new Float32Array(faces.length * 3 * 7);
    let o = 0;
    faces.forEach((face, index) => {
      face.forEach((vertex, corner) => {
        const [x, y, z] = vertices[vertex];
        // Lamp space is +z up with the front on +x. View space is +y up, facing +z.
        data.set([y, z, x, corner === 0 ? 1 : 0, corner === 1 ? 1 : 0, corner === 2 ? 1 : 0, index], o);
        o += 7;
      });
    });
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const stride = 7 * 4;
    const attr = (name, size, offset) => {
      const loc = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    };
    attr("aPos", 3, 0);
    attr("aBary", 3, 12);
    attr("aFace", 1, 24);
    this.count = faces.length * 3;
  }

  setFrame(rgb) {
    for (let i = 0; i < 80; i++) {
      this.pixels[i * 4] = rgb[i * 3];
      this.pixels[i * 4 + 1] = rgb[i * 3 + 1];
      this.pixels[i * 4 + 2] = rgb[i * 3 + 2];
      this.pixels[i * 4 + 3] = 255;
    }
    this.dirty = true;
  }

  _bindPointer() {
    const c = this.canvas;
    let px = 0;
    let py = 0;
    c.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.autoSpin = false;
      px = e.clientX;
      py = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.yaw += (e.clientX - px) * 0.008;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + (e.clientY - py) * 0.008));
      px = e.clientX;
      py = e.clientY;
    });
    const end = () => { this.dragging = false; };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  averageColor() {
    let r = 0; let g = 0; let b = 0;
    for (let i = 0; i < 80; i++) {
      r += this.pixels[i * 4]; g += this.pixels[i * 4 + 1]; b += this.pixels[i * 4 + 2];
    }
    return [r / 80, g / 80, b / 80];
  }

  _draw(time) {
    this.raf = requestAnimationFrame(this._loop);
    const gl = this.gl;
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (this.autoSpin) this.yaw += 0.0025;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.dirty) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 80, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
      this.dirty = false;
    }
    const cy = Math.cos(this.yaw); const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch); const sp = Math.sin(this.pitch);
    gl.uniformMatrix4fv(this.uView, false, new Float32Array([
      cy, sp * sy, -cp * sy, 0,
      0, cp, sp, 0,
      sy, -sp * cy, cp * cy, 0,
      0, 0, 0, 1,
    ]));
    gl.uniform1f(this.uAspect, w / h);
    gl.uniform1f(this.uLevel, this.level);
    gl.depthFunc(gl.GREATER);
    gl.clearDepth(0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }
}

const STYLE = `
:host { display: block; --g-bg: var(--card-background-color, #14161c); --g-line: var(--divider-color, rgba(127,127,127,.28));
  --g-ink: var(--primary-text-color, #e7e9ee); --g-dim: var(--secondary-text-color, #9aa1ad);
  --g-accent: var(--primary-color, #03a9f4); --g-field: var(--secondary-background-color, rgba(127,127,127,.12));
  color: var(--g-ink); font-family: var(--paper-font-body1_-_font-family, inherit); }
* { box-sizing: border-box; }
.head { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 0 12px; font-size: 20px; border-bottom: 1px solid var(--g-line); }
.wrap { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); padding: 16px; max-width: 1200px; margin: 0 auto; }
.wide .wrap { grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); align-items: start; }
.card .wrap { padding: 12px; }
.stage { position: relative; border-radius: 16px; overflow: hidden; background: #07080b; aspect-ratio: 1 / 1; max-height: 70vh; width: 100%; }
.wide .stage { position: sticky; top: 16px; }
.halo { position: absolute; inset: 0; transition: background .25s linear; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: grab; }
canvas:active { cursor: grabbing; }
.chips { position: absolute; left: 10px; top: 10px; display: flex; gap: 6px; flex-wrap: wrap; pointer-events: none; }
.chip { font-size: 12px; padding: 3px 8px; border-radius: 999px; background: rgba(0,0,0,.55); color: #e7e9ee; }
.stage-tools { position: absolute; right: 10px; bottom: 10px; }
.panel { display: grid; gap: 14px; min-width: 0; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-width: 0; }
.grow { flex: 1 1 140px; min-width: 0; }
button { font: inherit; font-size: 14px; color: var(--g-ink); background: var(--g-field); border: 1px solid var(--g-line);
  border-radius: 10px; min-height: 40px; padding: 8px 12px; cursor: pointer; transition: background .12s, border-color .12s; }
button:hover { border-color: var(--g-accent); }
button.on { background: var(--g-accent); border-color: var(--g-accent); color: var(--text-primary-color, #fff); }
button.danger { color: var(--error-color, #db4437); }
.tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
.tabs button { flex: 0 0 auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
.grid button { width: 100%; overflow-wrap: anywhere; }
h3 { margin: 6px 0 0; font-size: 13px; font-weight: 600; color: var(--g-dim); }
.fields { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--g-line); border-radius: 12px; }
.field { display: grid; gap: 6px; font-size: 14px; min-width: 0; }
.field .top { display: flex; justify-content: space-between; gap: 8px; }
.field output { color: var(--g-dim); font-variant-numeric: tabular-nums; }
input[type=range] { width: 100%; accent-color: var(--g-accent); margin: 0; height: 28px; }
input[type=color] { width: 100%; height: 40px; padding: 2px; border-radius: 10px; border: 1px solid var(--g-line); background: var(--g-field); cursor: pointer; }
input[type=text], input[type=search], select { width: 100%; min-height: 40px; font: inherit; font-size: 16px; color: var(--g-ink); background: var(--g-field);
  border: 1px solid var(--g-line); border-radius: 10px; padding: 6px 10px; }
select option { color: #111; }
.fault { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--error-color, #db4437); display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.look { display: flex; gap: 8px; align-items: center; min-width: 0; }
.look button:first-child { flex: 1 1 auto; min-width: 0; text-align: left; overflow-wrap: anywhere; }
.toggle { display: flex; }
.toggle button { flex: 1; }
`;

class GlorbStudio extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.tab = "effects";
    this.category = "Worlds";
    this.compact = false;
    this.wledFilter = "";
    this.alertForm = { pattern: "pulse", color: "#ff0000", color2: "#000000", duration: 4 };
    this._timers = {};
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._booted) {
      this._booted = true;
      this._boot();
    }
  }

  get hass() { return this._hass; }

  disconnectedCallback() {
    this._unsub?.();
    this._unsub = null;
    this.sphere?.destroy();
    this.sphere = null;
    this._resize?.disconnect();
    this._booted = false;
    this._built = false;
  }

  connectedCallback() {
    if (this._hass && !this._booted) {
      this._booted = true;
      this._boot();
    }
  }

  async _boot() {
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="wrap"><div>Loading</div></div>`;
    try {
      this.devices = await this._hass.callWS({ type: "glorb/devices" });
    } catch (err) {
      this.devices = [];
    }
    if (!this.devices.length) {
      this.shadowRoot.querySelector(".wrap").textContent = "No Glorb is set up yet.";
      return;
    }
    const wanted = this.config?.device;
    this.device = (this.devices.find((d) => d.id === wanted || d.name === wanted) || this.devices[0]).id;
    this.catalog = await this._hass.callWS({ type: "glorb/catalog", device: this.device });
    this._layout();
    this._unsub = await this._hass.connection.subscribeMessage((m) => this._onMessage(m), {
      type: "glorb/subscribe",
      device: this.device,
    });
  }

  _call(type, extra = {}) {
    return this._hass.callWS({ type, device: this.device, ...extra }).catch((err) => {
      console.warn("Glorb:", type, err);
    });
  }

  _debounced(key, fn, wait = 60) {
    clearTimeout(this._timers[key]);
    this._timers[key] = setTimeout(fn, wait);
  }

  _onMessage(m) {
    if (m.f) {
      const raw = atob(m.f);
      const rgb = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) rgb[i] = raw.charCodeAt(i);
      this.sphere?.setFrame(rgb);
      this._frames = (this._frames || 0) + 1;
      if (this._frames % 5 === 0 && this.halo) {
        const [r, g, b] = this.sphere.averageColor();
        const k = Math.min(1, 0.3 + this.sphere.level);
        this.halo.style.background = `radial-gradient(circle at 50% 50%, rgba(${r|0},${g|0},${b|0},${0.55 * k}) 28%, rgba(${r|0},${g|0},${b|0},0) 72%)`;
      }
    }
    if (m.s) this._onState(m.s);
  }

  _onState(s) {
    const previous = this.state;
    this.state = s;
    if (this.sphere) this.sphere.level = s.on ? 0.35 + 0.65 * (s.bri / 255) : 0.0;
    this._renderStatus();
    const changed = !previous
      || previous.effect !== s.effect
      || previous.running !== s.running
      || previous.fault !== s.fault
      || previous.on !== s.on
      || previous.looks.join() !== s.looks.join()
      || previous.wled.fx !== s.wled.fx
      || previous.wled.ps !== s.wled.ps;
    if (previous && JSON.stringify(previous.orientation) !== JSON.stringify(s.orientation)) {
      this._call("glorb/catalog").then((c) => { if (c) this.sphere?.setGeometry(c.geometry); });
    }
    if (changed) this._renderPanel();
  }

  _layout() {
    const wide = !this.compact && this.offsetWidth >= 820;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      ${this.isPanel ? `<div class="head"><ha-menu-button></ha-menu-button><span>Glorb</span></div>` : ""}
      <div class="${wide ? "wide" : ""} ${this.compact ? "card" : ""}">
        <div class="wrap">
          <div class="stage">
            <div class="halo"></div>
            <canvas></canvas>
            <div class="chips"></div>
            <div class="stage-tools"><button class="spin on">Turntable</button></div>
          </div>
          <div class="panel"></div>
        </div>
      </div>`;
    const root = this.shadowRoot;
    const menu = root.querySelector("ha-menu-button");
    if (menu) {
      menu.hass = this._hass;
      menu.narrow = this._narrow;
    }
    this.halo = root.querySelector(".halo");
    this.sphere = new Sphere(root.querySelector("canvas"), this.catalog.geometry);
    const spin = root.querySelector(".spin");
    spin.addEventListener("click", () => {
      this.sphere.autoSpin = !this.sphere.autoSpin;
      spin.classList.toggle("on", this.sphere.autoSpin);
    });
    root.querySelector("canvas").addEventListener("pointerdown", () => spin.classList.remove("on"));
    this.panelEl = root.querySelector(".panel");
    this.chipsEl = root.querySelector(".chips");
    this._resize?.disconnect();
    this._resize = new ResizeObserver(() => {
      const box = root.querySelector(".wrap")?.parentElement;
      if (box && !this.compact) box.classList.toggle("wide", this.offsetWidth >= 820);
    });
    this._resize.observe(this);
    this._renderPanel();
  }

  _renderStatus() {
    if (!this.chipsEl || !this.state) return;
    const s = this.state;
    const chips = [];
    if (!s.available) chips.push("Offline");
    else if (s.running) chips.push(`${Math.round(s.fps)} fps`);
    else chips.push("Lamp effect");
    if (s.audio_active) chips.push("Mic");
    if (s.wled.power) chips.push(`${(s.wled.power / 1000 * 5).toFixed(1)} W`);
    this.chipsEl.innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join("");
    const bri = this.panelEl?.querySelector(".master");
    if (bri && !bri.matches(":active")) bri.value = s.bri;
  }

  _el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  _button(label, onClick, on = false, cls = "") {
    const b = document.createElement("button");
    b.textContent = label;
    if (on) b.classList.add("on");
    if (cls) b.classList.add(cls);
    b.addEventListener("click", onClick);
    return b;
  }

  _renderPanel() {
    const panel = this.panelEl;
    if (!panel || !this.state) return;
    const s = this.state;
    panel.innerHTML = "";

    if (s.fault) {
      const fault = this._el(`<div class="fault"><span></span></div>`);
      fault.firstChild.textContent = s.fault;
      fault.append(this._button("Try again", () => s.effect && this._call("glorb/play", { effect: s.effect })));
      panel.append(fault);
    }

    const master = this._el(`<div class="row"></div>`);
    master.append(this._button(s.on ? "On" : "Off", () => this._call("glorb/power", { on: !s.on }), s.on));
    const bri = this._el(`<label class="grow field"><input class="master" type="range" min="1" max="255" aria-label="Brightness"></label>`);
    const input = bri.querySelector("input");
    input.value = s.bri;
    input.addEventListener("input", () => this._debounced("bri", () => this._call("glorb/power", { bri: +input.value }), 120));
    master.append(bri);
    panel.append(master);

    if (this.compact) {
      panel.append(this._effectSelect());
      return;
    }

    const tabs = this._el(`<div class="tabs" role="tablist"></div>`);
    [["effects", "Effects"], ["tune", "Tune"], ["lamp", "Lamp effects"], ["looks", "Looks"], ["alerts", "Alerts"], ["lineup", "Line up"]].forEach(([id, label]) => {
      tabs.append(this._button(label, () => { this.tab = id; this._renderPanel(); }, this.tab === id));
    });
    panel.append(tabs);
    const body = document.createElement("div");
    body.className = "panel";
    panel.append(body);
    ({
      effects: () => this._tabEffects(body),
      tune: () => this._tabTune(body),
      lamp: () => this._tabLamp(body),
      looks: () => this._tabLooks(body),
      alerts: () => this._tabAlerts(body),
      lineup: () => this._tabLineup(body),
    })[this.tab]();
  }

  _effectSelect() {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Effect");
    const s = this.state;
    if (!s.running) select.append(new Option("Lamp effect", "", true, true));
    this.catalog.effects.forEach((fx) => select.append(new Option(fx.name, fx.id, false, s.effect === fx.id && s.running)));
    select.addEventListener("change", () => select.value && this._call("glorb/play", { effect: select.value }));
    return select;
  }

  _tabEffects(body) {
    const s = this.state;
    const cats = this._el(`<div class="tabs"></div>`);
    this.catalog.categories.forEach((c) => {
      cats.append(this._button(c, () => { this.category = c; this._renderPanel(); }, this.category === c));
    });
    body.append(cats);
    const grid = this._el(`<div class="grid"></div>`);
    this.catalog.effects.filter((fx) => fx.category === this.category).forEach((fx) => {
      grid.append(this._button(fx.name, () => this._call("glorb/play", { effect: fx.id }), s.running && s.effect === fx.id));
    });
    body.append(grid);
    const fx = s.running && this.catalog.effects.find((e) => e.id === s.effect);
    if (fx && fx.params.length) {
      const fields = this._el(`<div class="fields"></div>`);
      fx.params.forEach((p) => {
        fields.append(this._field(p, s.params[p.key], (v) => {
          this._debounced(`p:${p.key}`, () => this._call("glorb/params", { params: { [p.key]: v } }));
        }));
      });
      body.append(fields);
    }
    if (s.running) body.append(this._button("Back to lamp effects", () => this._call("glorb/release")));
  }

  _field(p, value, onChange) {
    const wrap = this._el(`<label class="field"><span class="top"><span></span><output></output></span></label>`);
    wrap.querySelector(".top span").textContent = p.name;
    const out = wrap.querySelector("output");
    let control;
    if (p.kind === "range") {
      control = document.createElement("input");
      control.type = "range";
      control.min = p.min; control.max = p.max; control.step = p.step;
      control.value = value;
      const show = () => { out.textContent = (+control.value).toFixed(p.step < 0.1 ? 2 : p.step < 1 ? 1 : 0); };
      show();
      control.addEventListener("input", () => { show(); onChange(+control.value); });
    } else if (p.kind === "color") {
      control = document.createElement("input");
      control.type = "color";
      control.value = value;
      control.addEventListener("input", () => onChange(control.value));
    } else if (p.kind === "choice") {
      control = document.createElement("select");
      p.options.forEach((o) => control.append(new Option(o, o, false, o === value)));
      control.addEventListener("change", () => onChange(control.value));
    } else if (p.kind === "bool") {
      const row = this._el(`<div class="field"><span></span></div>`);
      row.firstChild.textContent = p.name;
      let current = !!value;
      const toggle = this._button(current ? "On" : "Off", () => {
        current = !current;
        toggle.textContent = current ? "On" : "Off";
        toggle.classList.toggle("on", current);
        onChange(current);
      }, current);
      row.append(toggle);
      return row;
    } else if (p.kind === "entity") {
      control = document.createElement("select");
      const domains = p.key === "entity" && p.name === "Weather" ? ["weather"] : ["sensor", "number", "input_number"];
      control.append(new Option("None", "", false, !value));
      Object.keys(this._hass.states)
        .filter((id) => domains.includes(id.split(".")[0]))
        .sort()
        .forEach((id) => {
          const name = this._hass.states[id].attributes.friendly_name || id;
          control.append(new Option(name, id, false, id === value));
        });
      control.addEventListener("change", () => onChange(control.value));
    } else {
      control = document.createElement("input");
      control.type = "text";
      control.value = value || "";
      control.addEventListener("change", () => onChange(control.value));
    }
    wrap.append(control);
    return wrap;
  }

  _tabTune(body) {
    const g = this.state.globals;
    const defs = [
      { key: "spin", name: "Spin", kind: "range", min: -60, max: 60, step: 0.5 },
      { key: "tumble", name: "Tumble", kind: "range", min: -60, max: 60, step: 0.5 },
      { key: "hue", name: "Hue shift", kind: "range", min: -180, max: 180, step: 1 },
      { key: "saturation", name: "Saturation", kind: "range", min: 0, max: 2, step: 0.01 },
      { key: "gain", name: "Effect brightness", kind: "range", min: 0, max: 2, step: 0.01 },
      { key: "gamma", name: "Gamma", kind: "range", min: 1, max: 3.5, step: 0.05 },
      { key: "transition", name: "Crossfade", kind: "range", min: 0, max: 15, step: 0.1 },
    ];
    const fields = this._el(`<div class="fields"></div>`);
    defs.forEach((p) => {
      fields.append(this._field(p, g[p.key], (v) => {
        this._debounced(`g:${p.key}`, () => this._call("glorb/globals", { values: { [p.key]: v } }));
      }));
    });
    body.append(fields);
  }

  _tabLamp(body) {
    const s = this.state;
    const presets = this._el(`<div class="grid"></div>`);
    Object.entries(this.catalog.wled_presets).forEach(([id, name]) => {
      presets.append(this._button(name, () => this._call("glorb/wled", { preset: +id }), !s.running && s.wled.ps === +id));
    });
    const presetHead = this._el(`<h3>Presets</h3>`);
    body.append(presetHead, presets);

    if (!s.running) {
      const fields = this._el(`<div class="fields"></div>`);
      const seg = (key, v) => this._debounced(`w:${key}`, () => this._call("glorb/wled", { seg: { [key]: v } }));
      fields.append(this._field({ name: "Speed", kind: "range", min: 0, max: 255, step: 1 }, s.wled.sx ?? 128, (v) => seg("sx", v)));
      fields.append(this._field({ name: "Intensity", kind: "range", min: 0, max: 255, step: 1 }, s.wled.ix ?? 128, (v) => seg("ix", v)));
      const pal = this._el(`<label class="field"><span>Palette</span><select></select></label>`);
      const select = pal.querySelector("select");
      this.catalog.wled_palettes.forEach((name, i) => select.append(new Option(name, i, false, i === s.wled.pal)));
      select.addEventListener("change", () => this._call("glorb/wled", { seg: { pal: +select.value } }));
      fields.append(pal);
      body.append(fields);
    }

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search effects";
    search.value = this.wledFilter;
    const grid = this._el(`<div class="grid"></div>`);
    const fill = () => {
      grid.innerHTML = "";
      const q = this.wledFilter.toLowerCase();
      this.catalog.wled_effects.forEach((name, i) => {
        if (name === "RSVD" || (q && !name.toLowerCase().includes(q))) return;
        grid.append(this._button(name, () => this._call("glorb/wled", { fx: i }), !s.running && s.wled.fx === i));
      });
    };
    search.addEventListener("input", () => { this.wledFilter = search.value; fill(); });
    fill();
    body.append(search, grid);
  }

  _tabLooks(body) {
    const s = this.state;
    const row = this._el(`<div class="row"></div>`);
    const name = document.createElement("input");
    name.type = "text";
    name.className = "grow";
    name.placeholder = "Name this look";
    row.append(name);
    row.append(this._button("Save look", () => {
      if (name.value.trim()) this._call("glorb/look_save", { name: name.value.trim() });
    }));
    body.append(row);
    s.looks.forEach((look) => {
      const line = this._el(`<div class="look"></div>`);
      line.append(this._button(look, () => this._call("glorb/look_play", { name: look })));
      line.append(this._button("Delete", () => this._call("glorb/look_delete", { name: look }), false, "danger"));
      body.append(line);
    });
  }

  _tabAlerts(body) {
    const form = this.alertForm;
    const fields = this._el(`<div class="fields"></div>`);
    fields.append(this._field({ name: "Pattern", kind: "choice", options: this.catalog.patterns }, form.pattern, (v) => { form.pattern = v; }));
    fields.append(this._field({ name: "Color", kind: "color" }, form.color, (v) => { form.color = v; }));
    fields.append(this._field({ name: "Second color", kind: "color" }, form.color2, (v) => { form.color2 = v; }));
    fields.append(this._field({ name: "Seconds", kind: "range", min: 0.5, max: 30, step: 0.5 }, form.duration, (v) => { form.duration = v; }));
    body.append(fields);
    body.append(this._button("Play alert", () => this._call("glorb/alert", { ...form })));
  }

  _tabLineup(body) {
    const o = this.state.orientation;
    const s = this.state;
    body.append(this._button("Show line-up colors", () => this._call("glorb/play", { effect: "calibrate" }), s.running && s.effect === "calibrate"));
    const fields = this._el(`<div class="fields"></div>`);
    const set = (key, v) => this._debounced(`o:${key}`, () => this._call("glorb/orientation", { values: { [key]: v } }));
    fields.append(this._field({ name: "Upside down", kind: "bool" }, o.flip, (v) => set("flip", v)));
    fields.append(this._field({ name: "Mirrored", kind: "bool" }, o.mirror, (v) => set("mirror", v)));
    fields.append(this._field({ name: "Rotation", kind: "range", min: 0, max: 360, step: 1 }, o.rotation, (v) => set("rotation", v)));
    body.append(fields);
  }

  // Lovelace card API
  setConfig(config) {
    this.config = config;
    this.compact = !config.full;
  }

  getCardSize() { return this.compact ? 7 : 12; }

  static getStubConfig() { return {}; }
}

class GlorbPanel extends GlorbStudio {
  constructor() {
    super();
    this.compact = false;
    this.isPanel = true;
  }

  set narrow(value) {
    this._narrow = value;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.narrow = value;
  }

  set panel(_value) {}
  set route(_value) {}
}

class GlorbCard extends GlorbStudio {
  connectedCallback() {
    super.connectedCallback();
    this.style.display = "block";
  }
}

if (!customElements.get("glorb-panel")) customElements.define("glorb-panel", GlorbPanel);
if (!customElements.get("glorb-card")) customElements.define("glorb-card", GlorbCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "glorb-card")) {
  window.customCards.push({ type: "glorb-card", name: "Glorb", description: "A live 3D model of the lamp.", preview: false });
}
