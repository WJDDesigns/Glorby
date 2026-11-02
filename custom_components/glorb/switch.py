"""Line-up controls, on the device page so each one acts the moment it's touched."""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_FLIP, CONF_MIRROR, DOMAIN
from .device import GlorbDevice


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    device: GlorbDevice = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            LineupSwitch(device),
            OrientationSwitch(device, CONF_FLIP, "Upside down", "mdi:rotate-3d-variant"),
            OrientationSwitch(device, CONF_MIRROR, "Mirrored", "mdi:flip-horizontal"),
        ]
    )


class _Base(SwitchEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, device: GlorbDevice) -> None:
        self.device = device
        self._attr_device_info = device.device_info

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.device.add_state_listener(self._changed))

    @callback
    def _changed(self) -> None:
        self.async_write_ha_state()


class LineupSwitch(_Base):
    _attr_name = "Line-up colors"
    _attr_icon = "mdi:axis-arrow"

    def __init__(self, device: GlorbDevice) -> None:
        super().__init__(device)
        self._attr_unique_id = f"{device.mac}_lineup"

    @property
    def is_on(self) -> bool:
        return self.device.lining_up

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.device.async_begin_lineup()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.device.async_end_lineup()


class OrientationSwitch(_Base):
    def __init__(self, device: GlorbDevice, key: str, name: str, icon: str) -> None:
        super().__init__(device)
        self.key = key
        self._attr_name = name
        self._attr_icon = icon
        self._attr_unique_id = f"{device.mac}_{key}"

    @property
    def is_on(self) -> bool:
        return bool(self.device.options[self.key])

    async def async_turn_on(self, **kwargs: Any) -> None:
        self.device.set_option(self.key, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        self.device.set_option(self.key, False)
