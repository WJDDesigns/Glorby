# Glorb for Home Assistant

Treats the lamp as a sphere rather than a strip. Effects are computed from each
LED's 3D position and streamed to the lamp, and a live 3D model mirrors it.

## Layout

- `custom_components/glorb/core/`: geometry, effects and engine. No Home Assistant
  imports, so it runs and tests on its own.
- `custom_components/glorb/`: the integration. Effect, palette, speed, color, line-up and orientation are live controls on the device page. Address, frame rate, gamma, microphone and resume are under Configure.
- `custom_components/glorb/frontend/glorb-ui.js`: the studio, with the 3D model and controls. `glorb-panel.js` shows it in the Home Assistant sidebar.
- `web/`: the same studio as a web app. It connects to a lamp directly, to Home Assistant, or to a demo lamp. To try it, run `python3 -m http.server 5180` here and open `/web/`, or `/web/?bench` for awkward test data.
  Without Home Assistant, `web/engine/` runs every effect in the browser and sends each frame to the lamp over its WebSocket. Music effects listen through the browser's microphone.
- `tools/serve.py`: the easiest way to run the web app. It serves the app, finds Glorbs on the network for it, and makes it reachable from any phone or computer at http://glorby.local. Only needs Python 3.
- `tools/`: `play.py` runs effects on the lamp from a terminal, `soak.py` tests frame
  rates, `contact_sheet.py` renders every effect to an image.

## Running the web app

```
python3 tools/serve.py
```

To have it start with the computer and stay running, run it once with `--install`
(macOS LaunchAgent or a Linux systemd user service).

Then open http://glorby.local on any device on the same Wi-Fi. The app searches for
Glorbs as soon as it opens and offers each one it finds with an "Add this lamp" button.
If a saved lamp gets a new address from the router, the app finds it again by its MAC
address and reconnects on its own.

- **Updates.** Every minute the helper pulls new commits for the branch it's on (only
  when nothing is edited locally). Open pages reload themselves when the app changes,
  and the helper restarts itself when `tools/serve.py` changes. `--no-update` turns this off.
- **Port.** It uses port 80 so the address needs no number. If 80 is taken, or Linux
  won't allow it without root, it uses 5180 and prints `http://glorby.local:5180`.
  Choose with `--port`, change the name with `--name`, turn it off with `--no-name`.
- **How it finds lamps.** A quick search (about 3 seconds) asks for WLED's mDNS
  service (`_wled._tcp`) and checks `/json/info` across this computer's own network
  and wherever a lamp was found before (kept in `~/.glorby/lamps.json`). If that finds
  nothing, a deep search (about 20 seconds) also checks the neighbouring ranges and the
  usual router defaults, which catches lamps a router keeps on their own range, such as
  192.168.4.x beside 192.168.1.x. Lamps are the WLED devices whose firmware version
  says GLORB. `python3 tools/serve.py --discover --deep` prints what it finds.
- **The friendly name.** On a Mac it registers `glorby.local` with the system's own
  mDNS service (`dns-sd`), on Linux with Avahi when installed, and otherwise answers
  mDNS itself. Android before 12 and some older Windows setups don't look up `.local`
  names; the plain IP address it prints always works.
- **Without the helper.** Served any other way, the app checks addresses itself:
  ones it has used before, `glorb.local`, then the ranges most home routers use
  (192.168.1.x, 192.168.0.x, 10.0.0.x and a few more). That takes a few seconds per
  range. A page on `https://` can't reach the network, so it can't search.

## Limits worth knowing

- 30 fps is the ceiling. 40 fps hung firmware 0.14.4-GLORB.1.2 until it was power-cycled.
  The integration stops streaming if the lamp misses two health checks.
- Live frames skip the firmware's gamma, so the engine applies it. The 3D view shows
  the values before gamma.
- 80 triangles means big shapes. Features on faces are chosen triangle by triangle.

## Adding an effect

Subclass `Effect` in `core/effects.py` with `@effect`, then return an (80, 3) array
of colors from `render`. `ctx.pos` holds each LED's direction with +z up and the
front on +x. Settings declared in `params` appear in the studio automatically.

Then add the same effect to `web/engine/effects.js`, so the web app has it too, and run
`python3 tools/check_web_effects.py`. It checks that both have the same effects and
settings, and that effects without randomness draw the same frames.

## Automations

```yaml
- action: glorb.alert
  target: { entity_id: light.glorb }
  data: { pattern: ring, color: "#ff0000", duration: 5 }
- action: glorb.play
  target: { entity_id: light.glorb }
  data: { effect: gauge, params: { entity: sensor.power, low: 0, high: 5000 } }
- action: glorb.set_params
  target: { entity_id: light.glorb }
  data: { params: { track: false, look_x: -0.6 } }
```
