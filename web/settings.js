// Settings: how the app is connected, what the lamp is, and which version of Glorby is running.
import { HomeAssistantLink, WledLink } from "./links.js";

const MANIFEST = new URL("../custom_components/glorb/manifest.json", import.meta.url);

/** What's known about this copy of the app. The helper knows the exact build; a plain page knows the number. */
export async function appVersion() {
  try {
    const response = await fetch("/api/version?full=1", { cache: "no-store" });
    if (response.ok) return { helper: true, ...(await response.json()) };
  } catch {
    // Not served by the helper.
  }
  try {
    const manifest = await (await fetch(MANIFEST, { cache: "no-store" })).json();
    return { helper: false, number: manifest.version };
  } catch {
    return { helper: false, number: "dev" };
  }
}

export function versionText(info) {
  const parts = [`Glorby ${info.number}`];
  if (info.commit) parts.push(`build ${info.commit}`);
  if (info.date) parts.push(new Date(info.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
  return parts.join(" · ");
}

async function checkNow() {
  const response = await fetch("/api/update", { method: "POST" });
  if (!response.ok) throw new Error("The helper didn't answer.");
  return response.json();
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function rows(pairs) {
  const list = el("dl", { className: "settings-rows" });
  pairs.filter(([, value]) => value !== undefined && value !== null && value !== "").forEach(([name, value]) => {
    list.append(el("dt", { textContent: name }), el("dd", { textContent: String(value) }));
  });
  return list;
}

function section(title, ...children) {
  return el("section", { className: "settings-section" }, el("h3", { textContent: title }), ...children);
}

function action(label, onClick, className = "") {
  const button = el("button", { type: "button", textContent: label, className });
  button.addEventListener("click", onClick);
  return button;
}

function connectionSection(link, actions, close) {
  let summary;
  let details = [];
  if (link instanceof WledLink) {
    const host = link.base.replace(/^https?:\/\//, "");
    summary = `Straight to ${link.title} on your network, with nothing else in between.`;
    details = [["Method", "Direct to the lamp (WLED)"], ["Address", host]];
  } else if (link instanceof HomeAssistantLink) {
    summary = `Through the Glorb integration in Home Assistant.`;
    details = [["Method", "Home Assistant"], ["Address", link.base.replace(/^https?:\/\//, "")], ["Lamp", link.title]];
  } else {
    summary = "To the pretend lamp. Nothing on your network is touched.";
    details = [["Method", "Demo lamp"]];
  }
  const go = (fn) => () => {
    close();
    fn();
  };
  return section(
    "Connection",
    el("p", { className: "settings-note", textContent: `Connected ${summary.charAt(0).toLowerCase()}${summary.slice(1)}` }),
    rows(details),
    el(
      "div",
      { className: "settings-actions" },
      action("Find lamps on my network", go(actions.findLamps)),
      action("Enter a lamp's address", go(actions.enterAddress)),
      action("Use Home Assistant", go(actions.homeAssistant)),
      link instanceof WledLink || link instanceof HomeAssistantLink ? action("Try the demo lamp", go(actions.demo)) : null,
    ),
  );
}

function lampSection(link) {
  if (!(link instanceof WledLink)) return null;
  const info = link.lamp?.info || {};
  const host = link.base.replace(/^https?:\/\//, "");
  const hours = info.uptime ? `${Math.floor(info.uptime / 3600)} h ${Math.floor((info.uptime % 3600) / 60)} min` : "";
  const open = (path) => () => window.open(`${link.base}${path}`, "_blank", "noopener");
  return section(
    "Lamp",
    rows([
      ["Name", info.name || link.title],
      ["Firmware", info.ver],
      ["LEDs", info.leds?.count],
      ["Wi-Fi signal", info.wifi?.signal !== undefined ? `${info.wifi.signal}%` : ""],
      ["Running for", hours],
      ["MAC address", info.mac],
      ["IP address", info.ip || host],
    ]),
    el(
      "div",
      { className: "settings-actions" },
      action("Lamp's own settings", open("/settings")),
      action("Firmware update", open("/update")),
    ),
    el("p", {
      className: "settings-note",
      textContent: "Firmware updates go over Wi-Fi from the lamp's own update page, so no cable is needed. Use only Glorb firmware made for this lamp.",
    }),
  );
}

function appSection(info) {
  const status = el("p", { className: "settings-note", "aria-live": "polite" });
  const parts = [
    rows([
      ["Version", info.number],
      ["Build", info.commit ? `${info.commit}${info.subject ? `: ${info.subject}` : ""}` : ""],
      ["Branch", info.branch],
      ["Updated", info.date ? new Date(info.date).toLocaleString() : ""],
    ]),
  ];
  if (info.helper) {
    status.textContent = info.auto
      ? `Checks for new versions every minute and reloads by itself. ${info.message || ""}`
      : info.message || "";
    const check = action("Check for updates", async () => {
      check.disabled = true;
      status.textContent = "Checking…";
      try {
        const result = await checkNow();
        status.textContent = result.updated ? `${result.message}. Reloading…` : result.message;
        if (result.updated) setTimeout(() => location.reload(), 1500);
      } catch (err) {
        status.textContent = err.message;
      } finally {
        check.disabled = false;
      }
    });
    parts.push(el("div", { className: "settings-actions" }, check), status);
  } else {
    status.textContent = "Run Glorby's helper (python3 tools/serve.py) to get updates automatically and open the app at http://glorby.local.";
    parts.push(status);
  }
  return section("App", ...parts);
}

/** Opens the settings window over whatever is showing. */
export async function openSettings({ link = null, actions }) {
  document.querySelector("dialog.settings")?.remove();
  const dialog = el("dialog", { className: "settings" });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const head = el(
    "div",
    { className: "settings-head" },
    el("h2", { textContent: "Settings" }),
    action("Done", close, "primary"),
  );
  dialog.append(head, el("p", { className: "settings-note", textContent: "Loading…" }));
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.body.append(dialog);
  dialog.showModal();
  const info = await appVersion();
  if (!dialog.isConnected) return;
  const parts = [head, link && connectionSection(link, actions, close), link && lampSection(link), appSection(info)];
  dialog.replaceChildren(...parts.filter(Boolean));
}

/** A quiet line under the connect screen with the version and a way into settings. */
export function footer(actions) {
  const line = el("footer", { className: "app-footer" });
  const text = el("span", { textContent: "Glorby" });
  const open = action("Settings", () => openSettings({ actions }), "link");
  line.append(text, open);
  appVersion().then((info) => {
    text.textContent = versionText(info);
  });
  return line;
}
