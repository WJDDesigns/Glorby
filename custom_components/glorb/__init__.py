"""The Glorb integration: a 3D effect engine and studio for the lamp."""
from __future__ import annotations

from pathlib import Path

from homeassistant.components import panel_custom
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_MAC, CONF_NAME, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import CONF_FPS, DEFAULT_FPS, DOMAIN, PANEL_PATH, STATIC_URL, VERSION
from .device import GlorbDevice
from .websocket_api import async_register_commands

PLATFORMS = [Platform.LIGHT]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {})
    async_register_commands(hass)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), False)]
    )
    module = f"{STATIC_URL}/glorb-card.js?v={VERSION}"
    add_extra_js_url(hass, module)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_PATH,
        webcomponent_name="glorb-panel",
        sidebar_title="Glorb",
        sidebar_icon="mdi:globe-light",
        module_url=module,
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    device = GlorbDevice(
        hass,
        entry.entry_id,
        entry.data[CONF_HOST],
        entry.data.get(CONF_NAME, "Glorb"),
        entry.data[CONF_MAC],
        entry.options.get(CONF_FPS, DEFAULT_FPS),
    )
    await device.async_start()
    hass.data[DOMAIN][entry.entry_id] = device
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        device: GlorbDevice = hass.data[DOMAIN].pop(entry.entry_id)
        await device.async_stop()
    return ok
