// The Glorby web app: pick how to reach the lamp, then open the same studio Home Assistant shows.
import "../custom_components/glorb/frontend/glorb-ui.js";
import { DemoLink, HomeAssistantLink, WledLink } from "./links.js";

const app = document.querySelector("#app");
const SAVED = "glorby.connection";

function remember(value) {
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
  link.decorateHead = (head) => {
    const change = document.createElement("button");
    change.textContent = "Change lamp";
    change.addEventListener("click", () => {
      remember(null);
      showChoices();
    });
    head.append(change);
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
  back.addEventListener("click", showChoices);
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
      remember(saved);
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
}

function showChoices() {
  const page = document.createElement("div");
  page.className = "connect";
  const heading = document.createElement("h1");
  heading.textContent = "Connect your Glorb";
  page.append(heading);
  const choices = [
    ["Lamp on my network", "Use its address, with nothing else installed", () => showForm({
      title: "Lamp on my network",
      kind: "lamp",
      fields: [field("Lamp address", "address", { placeholder: "192.168.1.50", inputMode: "url" })],
    })],
    ["Home Assistant", "Use the Glorb integration you already run", () => showForm({
      title: "Home Assistant",
      kind: "home-assistant",
      fields: [
        field("Home Assistant address", "address", { placeholder: "192.168.1.10:8123", inputMode: "url" }),
        field("Long-lived access token", "token", { type: "password" }),
      ],
    })],
    ["Try it without a lamp", "A pretend lamp to look around with", () => openStudio(new DemoLink())],
  ];
  choices.forEach(([title, detail, action]) => {
    const button = document.createElement("button");
    button.className = "connect-choice";
    const name = document.createElement("strong");
    name.textContent = title;
    const note = document.createElement("span");
    note.textContent = detail;
    button.append(name, note);
    button.addEventListener("click", action);
    page.append(button);
  });
  app.replaceChildren(page);
}

async function start() {
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
      // The saved lamp is gone, so ask again rather than strand the page.
    }
  }
  showChoices();
}

start();
