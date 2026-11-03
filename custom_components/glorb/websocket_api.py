"""Commands the studio page uses."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .core import palettes
from .core.effects import CATEGORIES, REGISTRY, SWEEP_DIRECTIONS
from .core.engine import OVERLAY_PATTERNS
from .device import GlorbDevice


def _device(hass: HomeAssistant, connection, msg) -> GlorbDevice | None:
    device = hass.data.get(DOMAIN, {}).get(msg["device"])
    if device is None:
        connection.send_error(msg["id"], "not_found", "No such Glorb")
    return device


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    for command in (
        ws_devices, ws_catalog, ws_subscribe, ws_play, ws_params, ws_globals, ws_alert,
        ws_release, ws_wled, ws_power, ws_look_save, ws_look_delete, ws_look_play,
    ):
        websocket_api.async_register_command(hass, command)


@websocket_api.websocket_command({vol.Required("type"): "glorb/devices"})
@callback
def ws_devices(hass, connection, msg) -> None:
    devices = hass.data.get(DOMAIN, {})
    connection.send_result(
        msg["id"],
        [{"id": key, "name": d.name, "host": d.host} for key, d in devices.items()],
    )


@websocket_api.websocket_command({vol.Required("type"): "glorb/catalog", vol.Required("device"): str})
@callback
def ws_catalog(hass, connection, msg) -> None:
    device = _device(hass, connection, msg)
    if device is None:
        return
    connection.send_result(
        msg["id"],
        {
            "categories": list(CATEGORIES),
            "effects": [fx.describe() for fx in REGISTRY.values()],
            "palettes": palettes.stops(),
            "patterns": list(OVERLAY_PATTERNS),
            "sweep_directions": list(SWEEP_DIRECTIONS),
            "wled_effects": device.wled_effects,
            "wled_fxdata": device.wled_fxdata,
            "wled_palettes": device.wled_palettes,
            "wled_presets": device.wled_presets,
            "geometry": device.geometry(),
        },
    )


@websocket_api.websocket_command({vol.Required("type"): "glorb/subscribe", vol.Required("device"): str})
@callback
def ws_subscribe(hass, connection, msg) -> None:
    device = _device(hass, connection, msg)
    if device is None:
        return

    @callback
    def send_frame(frame: str) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], {"f": frame}))

    @callback
    def send_state() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], {"s": device.state()}))

    remove_view = device.add_view_listener(send_frame)
    remove_state = device.add_state_listener(send_state)

    @callback
    def unsubscribe() -> None:
        remove_view()
        remove_state()

    connection.subscriptions[msg["id"]] = unsubscribe
    connection.send_result(msg["id"])
    send_state()


def _simple(schema: dict, handler):
    """Wrap a command that acts on a device and answers with nothing."""

    @websocket_api.websocket_command({vol.Required("device"): str, **schema})
    @websocket_api.async_response
    async def command(hass, connection, msg) -> None:
        device = _device(hass, connection, msg)
        if device is None:
            return
        try:
            await handler(device, msg)
        except (KeyError, ValueError) as err:
            connection.send_error(msg["id"], "invalid", str(err))
            return
        connection.send_result(msg["id"])

    return command


async def _play(device: GlorbDevice, msg: dict[str, Any]) -> None:
    await device.async_wled({"on": True})
    await device.async_play(msg["effect"], msg.get("params"), msg.get("transition"))


ws_play = _simple(
    {
        vol.Required("type"): "glorb/play",
        vol.Required("effect"): str,
        vol.Optional("params"): dict,
        vol.Optional("transition"): vol.Coerce(float),
    },
    _play,
)


async def _params(device: GlorbDevice, msg: dict[str, Any]) -> None:
    await device.async_set_params(msg["params"])


ws_params = _simple({vol.Required("type"): "glorb/params", vol.Required("params"): dict}, _params)


async def _globals(device: GlorbDevice, msg: dict[str, Any]) -> None:
    device.async_set_globals(msg["values"])


ws_globals = _simple({vol.Required("type"): "glorb/globals", vol.Required("values"): dict}, _globals)


async def _alert(device: GlorbDevice, msg: dict[str, Any]) -> None:
    await device.async_alert(
        msg["pattern"],
        msg["color"],
        msg["color2"],
        msg["duration"],
        msg.get("opacity", 1.0),
        msg.get("direction", SWEEP_DIRECTIONS[0]),
        msg.get("speed", 1.0),
        msg.get("width", 0.5),
    )


ws_alert = _simple(
    {
        vol.Required("type"): "glorb/alert",
        vol.Required("pattern"): str,
        vol.Required("color"): str,
        vol.Required("color2"): str,
        vol.Required("duration"): vol.Coerce(float),
        vol.Optional("opacity"): vol.Coerce(float),
        vol.Optional("direction"): vol.In(SWEEP_DIRECTIONS),
        vol.Optional("speed"): vol.Coerce(float),
        vol.Optional("width"): vol.Coerce(float),
    },
    _alert,
)


async def _release(device: GlorbDevice, msg: dict[str, Any]) -> None:
    await device.async_release()


ws_release = _simple({vol.Required("type"): "glorb/release"}, _release)


async def _wled(device: GlorbDevice, msg: dict[str, Any]) -> None:
    await device.async_play_wled(fx=msg.get("fx"), preset=msg.get("preset"), seg=msg.get("seg"))


ws_wled = _simple(
    {
        vol.Required("type"): "glorb/wled",
        vol.Optional("fx"): int,
        vol.Optional("preset"): int,
        vol.Optional("seg"): dict,
    },
    _wled,
)


async def _power(device: GlorbDevice, msg: dict[str, Any]) -> None:
    payload: dict[str, Any] = {}
    if "on" in msg:
        payload["on"] = msg["on"]
        if not msg["on"]:
            await device.async_release()
    if "bri" in msg:
        payload["bri"] = msg["bri"]
    await device.async_wled(payload)


ws_power = _simple(
    {vol.Required("type"): "glorb/power", vol.Optional("on"): bool, vol.Optional("bri"): vol.All(int, vol.Range(0, 255))},
    _power,
)


async def _look_save(device: GlorbDevice, msg: dict[str, Any]) -> None:
    device.save_look(msg["name"])


ws_look_save = _simple({vol.Required("type"): "glorb/look_save", vol.Required("name"): str}, _look_save)


async def _look_delete(device: GlorbDevice, msg: dict[str, Any]) -> None:
    device.delete_look(msg["name"])


ws_look_delete = _simple({vol.Required("type"): "glorb/look_delete", vol.Required("name"): str}, _look_delete)


async def _look_play(device: GlorbDevice, msg: dict[str, Any]) -> None:
    await device.async_play_look(msg["name"])


ws_look_play = _simple({vol.Required("type"): "glorb/look_play", vol.Required("name"): str}, _look_play)
