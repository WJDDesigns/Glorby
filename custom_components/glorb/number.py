"""Which way the lamp's front faces, as a live slider on the device page."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import DEGREE, EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_ROTATION, DOMAIN
from .device import GlorbDevice


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([RotationNumber(hass.data[DOMAIN][entry.entry_id])])


class RotationNumber(NumberEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_entity_category = EntityCategory.CONFIG
    _attr_name = "Rotation"
    _attr_icon = "mdi:rotate-360"
    _attr_mode = NumberMode.SLIDER
    _attr_native_min_value = 0
    _attr_native_max_value = 360
    _attr_native_step = 1
    _attr_native_unit_of_measurement = DEGREE

    def __init__(self, device: GlorbDevice) -> None:
        self.device = device
        self._attr_unique_id = f"{device.mac}_{CONF_ROTATION}"
        self._attr_device_info = device.device_info

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.device.add_state_listener(self._changed))

    @callback
    def _changed(self) -> None:
        self.async_write_ha_state()

    @property
    def native_value(self) -> float:
        return float(self.device.options[CONF_ROTATION])

    async def async_set_native_value(self, value: float) -> None:
        self.device.set_option(CONF_ROTATION, value)
