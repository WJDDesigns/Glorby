"""Live sliders on the device page. They only touch the engine, never the lamp's config."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import DEGREE, EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_ROTATION, CONF_TRANSITION, DOMAIN
from .device import GlorbDevice

# key, name, icon, min, max, step
_GLOBALS = (
    ("spin", "Spin", "mdi:rotate-right", -60, 60, 0.5),
    ("tumble", "Tumble", "mdi:rotate-orbit", -60, 60, 0.5),
    ("hue", "Hue shift", "mdi:palette-swatch", -180, 180, 1),
    ("saturation", "Saturation", "mdi:invert-colors", 0, 2, 0.01),
    ("gain", "Effect brightness", "mdi:brightness-6", 0, 2, 0.01),
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    device: GlorbDevice = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            RotationNumber(device),
            CrossfadeNumber(device),
            SpeedNumber(device),
            *(GlobalNumber(device, *spec) for spec in _GLOBALS),
        ]
    )


class _Base(NumberEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_mode = NumberMode.SLIDER

    def __init__(self, device: GlorbDevice, key: str) -> None:
        self.device = device
        self._attr_unique_id = f"{device.mac}_{key}"
        self._attr_device_info = device.device_info

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.device.add_state_listener(self._changed))

    @callback
    def _changed(self) -> None:
        self.async_write_ha_state()


class RotationNumber(_Base):
    """Which way the lamp's front faces."""

    _attr_entity_category = EntityCategory.CONFIG
    _attr_name = "Rotation"
    _attr_icon = "mdi:rotate-360"
    _attr_native_min_value = 0
    _attr_native_max_value = 360
    _attr_native_step = 1
    _attr_native_unit_of_measurement = DEGREE

    def __init__(self, device: GlorbDevice) -> None:
        super().__init__(device, CONF_ROTATION)

    @property
    def native_value(self) -> float:
        return float(self.device.options[CONF_ROTATION])

    async def async_set_native_value(self, value: float) -> None:
        self.device.set_option(CONF_ROTATION, value)


class CrossfadeNumber(_Base):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_name = "Crossfade"
    _attr_icon = "mdi:transition"
    _attr_native_min_value = 0
    _attr_native_max_value = 15
    _attr_native_step = 0.1
    _attr_native_unit_of_measurement = "s"

    def __init__(self, device: GlorbDevice) -> None:
        super().__init__(device, CONF_TRANSITION)

    @property
    def native_value(self) -> float:
        return float(self.device.options[CONF_TRANSITION])

    async def async_set_native_value(self, value: float) -> None:
        self.device.set_option(CONF_TRANSITION, value)


class SpeedNumber(_Base):
    """Only offered while the playing effect has a speed."""

    _attr_name = "Effect speed"
    _attr_icon = "mdi:speedometer"
    _attr_native_min_value = 0
    _attr_native_max_value = 4
    _attr_native_step = 0.05

    def __init__(self, device: GlorbDevice) -> None:
        super().__init__(device, "effect_speed")

    @property
    def available(self) -> bool:
        return self.device.engine.running and "speed" in self.device.current_params()

    @property
    def native_value(self) -> float | None:
        return self.device.current_params().get("speed")

    async def async_set_native_value(self, value: float) -> None:
        await self.device.async_set_params({"speed": value})


class GlobalNumber(_Base):
    def __init__(self, device: GlorbDevice, key: str, name: str, icon: str, low: float, high: float, step: float) -> None:
        super().__init__(device, f"global_{key}")
        self.key = key
        self._attr_name = name
        self._attr_icon = icon
        self._attr_native_min_value = low
        self._attr_native_max_value = high
        self._attr_native_step = step

    @property
    def native_value(self) -> float:
        return float(getattr(self.device.engine.globals, self.key))

    async def async_set_native_value(self, value: float) -> None:
        self.device.async_set_globals({self.key: value})
