# Glorb for Home Assistant

Treats the lamp as a sphere rather than a strip. Effects are computed from each
LED's 3D position and streamed to the lamp, and a live 3D model mirrors it.

## Layout

- `custom_components/glorb/core/`: geometry, effects and engine. No Home Assistant
  imports, so it runs and tests on its own.
- `custom_components/glorb/`: the integration (light entity, services, studio commands).
- `custom_components/glorb/frontend/glorb-card.js`: the sidebar studio and `custom:glorb-card`.
- `tools/`: `play.py` runs effects on the lamp from a terminal, `soak.py` tests frame
  rates, `contact_sheet.py` renders every effect to an image.

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
