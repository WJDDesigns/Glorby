// The Glorb sidebar page: the shared studio, linked to this Home Assistant.
const version = new URL(import.meta.url).search;
const ready = import(`./glorb-ui.js${version}`);

class HassLink {
  constructor(panel) {
    this.panel = panel;
  }

  async device() {
    if (!this._device) {
      const devices = await this.panel.hass.callWS({ type: "glorb/devices" });
      if (!devices.length) throw new Error("No Glorb is set up yet.");
      this._device = devices[0].id;
    }
    return this._device;
  }

  async catalog() {
    return this.panel.hass.callWS({ type: "glorb/catalog", device: await this.device() });
  }

  async subscribe(onMessage) {
    return this.panel.hass.connection.subscribeMessage(onMessage, { type: "glorb/subscribe", device: await this.device() });
  }

  async call(type, extra = {}) {
    return this.panel.hass.callWS({ type, device: await this.device(), ...extra });
  }

  entities(domains) {
    const states = this.panel.hass.states;
    return Object.keys(states)
      .filter((id) => domains.includes(id.split(".")[0]))
      .sort()
      .map((id) => ({ id, name: states[id].attributes.friendly_name || id }));
  }

  decorateHead(head) {
    const menu = document.createElement("ha-menu-button");
    menu.hass = this.panel.hass;
    menu.narrow = this.panel.narrow;
    this.panel.menu = menu;
    head.prepend(menu);
  }
}

class GlorbPanel extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    this._start();
  }

  get hass() { return this._hass; }

  set narrow(value) {
    this._narrow = value;
    if (this.menu) this.menu.narrow = value;
  }

  get narrow() { return this._narrow; }

  set panel(_value) {}

  set route(_value) {}

  connectedCallback() {
    this._start();
  }

  async _start() {
    if (this._started || !this._hass || !this.isConnected) return;
    this._started = true;
    await ready;
    const studio = document.createElement("glorb-studio");
    studio.link = new HassLink(this);
    this.append(studio);
  }
}

if (!customElements.get("glorb-panel")) customElements.define("glorb-panel", GlorbPanel);
