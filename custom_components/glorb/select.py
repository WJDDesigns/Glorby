"""Live effect pickers on the device page. Choosing one acts immediately."""
from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import const
from .core.effects import REGISTRY
from .core.palettes import NAMES as PALETTES
from .device import LINEUP_EFFECT, GlorbDevice

LAMP_OWN = "The lamp's own effect"
LAST = "Last effect played"
_EFFECTS = {fx.name: fx.id for fx in REGISTRY.values() if fx.id != LINEUP_EFFECT}
_NAMES = {effect_id: name for name, effect_id in _EFFECTS.items()}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    device: GlorbDevice = hass.data[const.DOMAIN][entry.entry_id]
    async_add_entities([EffectSelect(device), PaletteSelect(device), DefaultEffectSelect(device)])


class _Base(SelectEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    key = ""

    def __init__(self, device: GlorbDevice) -> None:
        self.device = device
        self._attr_unique_id = f"{device.mac}_{self.key}"
        self._attr_device_info = device.device_info

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.device.add_state_listener(self._changed))

    @callback
    def _changed(self) -> None:
        self.async_write_ha_state()


class EffectSelect(_Base):
    key = "effect"
    _attr_name = "Effect"
    _attr_icon = "mdi:creation"
    _attr_options = [LAMP_OWN, *_EFFECTS]

    @property
    def current_option(self) -> str | None:
        engine = self.device.engine
        if not engine.running or engine.current is None:
            return LAMP_OWN
        return _NAMES.get(engine.current.id)

    async def async_select_option(self, option: str) -> None:
        if option == LAMP_OWN:
            await self.device.async_release()
            return
        await self.device.async_wled({"on": True})
        await self.device.async_play(_EFFECTS[option])


class PaletteSelect(_Base):
    """Only offered while the playing effect has a palette."""

    key = "palette"
    _attr_name = "Palette"
    _attr_icon = "mdi:palette"
    _attr_options = list(PALETTES)

    @property
    def available(self) -> bool:
        return self.device.engine.running and "palette" in self.device.current_params()

    @property
    def current_option(self) -> str | None:
        return self.device.current_params().get("palette")

    async def async_select_option(self, option: str) -> None:
        await self.device.async_set_params({"palette": option})


class DefaultEffectSelect(_Base):
    key = "default_effect"
    _attr_name = "Default effect"
    _attr_icon = "mdi:star-outline"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_options = [LAST, LAMP_OWN, *_EFFECTS]

    @property
    def current_option(self) -> str | None:
        choice = self.device.options[const.CONF_ON_EFFECT]
        if choice == const.ON_EFFECT_LAST:
            return LAST
        if choice == const.ON_EFFECT_LAMP:
            return LAMP_OWN
        return _NAMES.get(choice)

    async def async_select_option(self, option: str) -> None:
        value = {LAST: const.ON_EFFECT_LAST, LAMP_OWN: const.ON_EFFECT_LAMP}.get(option) or _EFFECTS[option]
        self.device.set_option(const.CONF_ON_EFFECT, value)
