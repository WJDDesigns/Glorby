// The Glorby web app: pick how to reach the lamp, then open the same studio Home Assistant shows.
import "../custom_components/glorb/frontend/glorb-ui.js";
import { DemoLink, HomeAssistantLink, WledLink } from "./links.js";
import { findHomeAssistant, findLamps } from "./discover.js";
import { footer, openSettings } from "./settings.js";

const app = document.querySelector("#app");
const SAVED = "glorby.connection";
// A search that is still running belongs to the page that started it.
let search = null;

function stopSearch() {
  search?.abort();
  search = null;
}

function remember(value, link) {
  // The lamp's MAC address lets the app find it again if the router gives it a new address.
  const mac = link?.lamp?.info?.mac;
  if (value && mac) value = { ...value, mac, name: link.title };
  try {
    if (value) localStorage.setItem(SAVED, JSON.stringify(value));
    else localStorage.removeItem(SAVED);
  } catch {
    // Private windows can refuse storage. The app still works, it just asks again.
  }
}

function recall() {
  try {
    return JSON.parse(localStorage.getItem(SAVED));
  } catch {
    return null;
  }
}

function makeLink(saved) {
  if (saved.kind === "lamp") return new WledLink(saved.address);
  if (saved.kind === "home-assistant") return new HomeAssistantLink(saved.address, saved.token);
  return new DemoLink({ awkward: saved.kind === "bench" });
}

function openStudio(link) {
  stopSearch();
  link.decorateHead = (head) => {
    const settings = document.createElement("button");
    settings.textContent = "Settings";
    settings.addEventListener("click", () => openSettings({ link, actions: connectActions() }));
    head.append(settings);
  };
  app.replaceChildren();
  const studio = document.createElement("glorb-studio");
  studio.link = link;
  app.append(studio);
}

function field(label, name, attrs = {}) {
  const wrap = document.createElement("label");
  wrap.className = "connect-field";
  wrap.textContent = label;
  const input = document.createElement("input");
  input.name = name;
  Object.assign(input, { autocapitalize: "off", autocomplete: "off", spellcheck: false, required: true, ...attrs });
  wrap.append(input);
  return wrap;
}

function showForm({ title, fields, kind }) {
  stopSearch();
  const form = document.createElement("form");
  form.className = "connect";
  const heading = document.createElement("h1");
  heading.textContent = title;
  form.append(heading, ...fields);
  const error = document.createElement("p");
  error.className = "connect-error";
  error.hidden = true;
  error.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "connect-actions";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Back";
  back.addEventListener("click", () => showChoices());
  const go = document.createElement("button");
  go.type = "submit";
  go.className = "primary";
  go.textContent = "Connect";
  actions.append(back, go);
  form.append(error, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saved = { kind, ...Object.fromEntries(new FormData(form)) };
    saved.address = saved.address.trim();
    go.disabled = true;
    go.textContent = "Connecting";
    error.hidden = true;
    const link = makeLink(saved);
    try {
      await link.check();
      remember(saved, link);
      openStudio(link);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      go.disabled = false;
      go.textContent = "Connect";
    }
  });
  app.replaceChildren(form);
  form.querySelector("input").focus();
  return form;
}

const lampForm = () => showForm({
  title: "Lamp on my network",
  kind: "lamp",
  fields: [field("Lamp address", "address", { placeholder: "192.168.1.50", inputMode: "url" })],
});

async function homeAssistantForm() {
  const form = showForm({
    title: "Home Assistant",
    kind: "home-assistant",
    fields: [
      field("Home Assistant address", "address", { placeholder: "192.168.1.10:8123", inputMode: "url" }),
      field("Long-lived access token", "token", { type: "password" }),
    ],
  });
  const address = form.elements.address;
  const guess = await findHomeAssistant();
  if (guess && !address.value && form.isConnected) {
    address.value = guess;
    form.elements.token.focus();
  }
}

/** The ways to connect, shared by the connect screen and Settings. */
function connectActions() {
  return {
    findLamps: () => {
      const before = recall();
      showChoices({ hints: before?.address ? [before.address] : [] });
    },
    enterAddress: lampForm,
    homeAssistant: homeAssistantForm,
    demo: () => openStudio(new DemoLink()),
  };
}

function choiceButton(title, detail, action) {
  const button = document.createElement("button");
  button.className = "connect-choice";
  const name = document.createElement("strong");
  name.textContent = title;
  const note = document.createElement("span");
  note.textContent = detail;
  button.append(name, note);
  button.addEventListener("click", action);
  return button;
}

async function addLamp(lamp, button) {
  const note = button.querySelector("span");
  button.disabled = true;
  note.textContent = "Connecting";
  const saved = { kind: "lamp", address: lamp.address };
  const link = makeLink(saved);
  try {
    await link.check();
    remember(saved, link);
    openStudio(link);
  } catch (err) {
    button.disabled = false;
    note.textContent = err.message;
  }
}

/** The "Lamps on your network" box: searches as soon as it appears and offers each Glorb it finds. */
function finder({ hints, reconnect }) {
  const box = document.createElement("section");
  box.className = "finder";
  const status = document.createElement("p");
  status.className = "finder-status";
  status.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  list.className = "finder-list";
  const again = document.createElement("button");
  again.type = "button";
  again.className = "finder-again";
  again.textContent = "Search again";
  again.hidden = true;
  box.append(status, list, again);

  const run = async () => {
    stopSearch();
    const controller = new AbortController();
    search = controller;
    list.replaceChildren();
    again.hidden = true;
    box.classList.add("searching");
    let count = 0;
    const result = await findLamps({
      hints,
      signal: controller.signal,
      onProgress: (text) => {
        if (!count) status.textContent = `Looking for your Glorb. ${text}…`;
      },
      onLamp: (lamp) => {
        count += 1;
        const button = choiceButton(lamp.name, `${lamp.address} · Add this lamp`, () => addLamp(lamp, button));
        button.classList.add("found");
        list.append(button);
        status.textContent = count === 1 ? "Found a Glorb. Tap it to add it." : `Found ${count} Glorbs. Tap one to add it.`;
        // The lamp that was saved before, now at a new address: carry straight on.
        if (reconnect?.mac && lamp.mac === reconnect.mac) addLamp(lamp, button);
      },
    });
    if (controller.signal.aborted) return;
    search = null;
    box.classList.remove("searching");
    again.hidden = false;
    if (result.blocked) {
      status.textContent = "This secure page can't search your network. Run Glorby's helper and open http://glorby.local, or connect another way below.";
    } else if (!result.lamps.length) {
      const extra = result.others ? ` It found ${result.others === 1 ? "a WLED light" : `${result.others} WLED lights`} that ${result.others === 1 ? "isn't a Glorb" : "aren't Glorbs"}.` : "";
      status.textContent = `No Glorb turned up.${extra} Check it's switched on and on the same Wi-Fi as this device, then search again, or enter its address below.`;
    } else {
      status.textContent = count === 1 ? "Found a Glorb. Tap it to add it." : `Found ${count} Glorbs. Tap one to add it.`;
    }
  };
  again.addEventListener("click", run);
  run();
  return box;
}

function showChoices({ hints = [], reconnect = null } = {}) {
  const page = document.createElement("div");
  page.className = "connect";
  const heading = document.createElement("h1");
  heading.textContent = "Connect your Glorb";
  page.append(heading);
  if (reconnect) {
    const note = document.createElement("p");
    note.className = "finder-note";
    note.textContent = `${reconnect.name || "Your lamp"} didn't answer at ${reconnect.address}. Looking for it on the network.`;
    page.append(note);
  }
  page.append(finder({ hints, reconnect }));
  const other = document.createElement("h2");
  other.className = "connect-or";
  other.textContent = "Or connect another way";
  page.append(other);
  page.append(
    choiceButton("Enter a lamp's address", "If it didn't turn up above", lampForm),
    choiceButton("Home Assistant", "Use the Glorb integration you already run", homeAssistantForm),
    choiceButton("Try it without a lamp", "A pretend lamp to look around with", () => openStudio(new DemoLink())),
    footer(connectActions()),
  );
  app.replaceChildren(page);
}

/** When Glorby's helper serves the page, reload as soon as a new version of the app lands. */
async function followUpdates() {
  const current = async () => {
    const response = await fetch("/api/version", { cache: "no-store" });
    if (!response.ok) throw new Error("no helper");
    return (await response.json()).version;
  };
  let seen;
  try {
    seen = await current();
  } catch {
    return; // Served some other way, so there's nothing to follow.
  }
  setInterval(async () => {
    try {
      if ((await current()) !== seen) location.reload();
    } catch {
      // The helper is restarting or the network blinked. Try again next time.
    }
  }, 5000);
}

async function start() {
  followUpdates();
  const params = new URLSearchParams(location.search);
  if (params.has("bench")) {
    openStudio(makeLink({ kind: "bench" }));
    return;
  }
  // Served from the lamp itself, there is nothing to ask.
  const here = new WledLink("");
  try {
    await here.check();
    openStudio(here);
    return;
  } catch {
    // Not on a lamp, so carry on.
  }
  const saved = recall();
  if (saved) {
    const link = makeLink(saved);
    try {
      await link.check();
      openStudio(link);
      return;
    } catch {
      // The saved lamp didn't answer. If it only moved address, the search finds it again.
      if (saved.kind === "lamp") {
        showChoices({ hints: [saved.address], reconnect: saved });
        return;
      }
    }
  }
  showChoices({ hints: saved?.address ? [saved.address] : [] });
}

start();
