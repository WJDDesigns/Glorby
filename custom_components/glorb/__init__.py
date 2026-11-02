"""The Glorb integration: a 3D effect engine and studio for the lamp."""
from __future__ import annotations

from pathlib import Path

from homeassistant.components import panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_MAC, CONF_NAME, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, PANEL_PATH, STATIC_URL, VERSION
from .device import GlorbDevice
from .websocket_api import async_register_commands

PLATFORMS = [Platform.LIGHT, Platform.NUMBER, Platform.SWITCH]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {})
    async_register_commands(hass)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), False)]
    )
    module = f"{STATIC_URL}/glorb-panel.js?v={VERSION}"
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
        dict(entry.options),
    )
    await device.async_start()
    hass.data[DOMAIN][entry.entry_id] = device
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Settings apply live. Only a new address needs a fresh start."""
    device: GlorbDevice = hass.data[DOMAIN][entry.entry_id]
    if device.host != entry.data[CONF_HOST]:
        await hass.config_entries.async_reload(entry.entry_id)
    else:
        await device.async_apply_options(dict(entry.options))


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        device: GlorbDevice = hass.data[DOMAIN].pop(entry.entry_id)
        await device.async_stop()
    return ok
