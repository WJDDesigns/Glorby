"""The lamp as a normal Home Assistant light, plus services for automations."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_EFFECT,
    ATTR_RGB_COLOR,
    ColorMode,
    LightEntity,
    LightEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, entity_platform
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_ON_EFFECT, DOMAIN, ON_EFFECT_LAMP, ON_EFFECT_LAST
from .core.effects import REGISTRY, SWEEP_DIRECTIONS
from .core.engine import OVERLAY_PATTERNS
from .device import GlorbDevice

_LOGGER = logging.getLogger(__name__)

_NAME_TO_ID = {fx.name: fx.id for fx in REGISTRY.values()}
_LOOK = "Look: "
_PRESET = "Preset: "
_WLED = "Lamp: "


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    device: GlorbDevice = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([GlorbLight(device)])

    platform = entity_platform.async_get_current_platform()
    platform.async_register_entity_service(
        "play",
        {
            vol.Required("effect"): vol.In(sorted(REGISTRY)),
            vol.Optional("params"): dict,
            vol.Optional("transition"): vol.Coerce(float),
        },
        "async_service_play",
    )
    platform.async_register_entity_service("set_params", {vol.Required("params"): dict}, "async_service_params")
    platform.async_register_entity_service(
        "set_globals",
        {
            vol.Optional("spin"): vol.Coerce(float),
            vol.Optional("tumble"): vol.Coerce(float),
            vol.Optional("hue"): vol.Coerce(float),
            vol.Optional("saturation"): vol.Coerce(float),
            vol.Optional("gain"): vol.Coerce(float),
            vol.Optional("gamma"): vol.Coerce(float),
            vol.Optional("transition"): vol.Coerce(float),
        },
        "async_service_globals",
    )
    platform.async_register_entity_service(
        "alert",
        {
            vol.Optional("pattern", default="pulse"): vol.In(OVERLAY_PATTERNS),
            vol.Optional("color", default="#ff0000"): cv.string,
            vol.Optional("color2", default="#000000"): cv.string,
            vol.Optional("duration", default=3.0): vol.Coerce(float),
            vol.Optional("opacity", default=1.0): vol.Coerce(float),
            vol.Optional("direction", default=SWEEP_DIRECTIONS[0]): vol.In(SWEEP_DIRECTIONS),
            vol.Optional("speed", default=1.0): vol.Coerce(float),
            vol.Optional("width", default=0.5): vol.Coerce(float),
        },
        "async_service_alert",
    )
    platform.async_register_entity_service("play_look", {vol.Required("name"): cv.string}, "async_service_look")
    platform.async_register_entity_service("show_image", {vol.Required("source"): cv.string}, "async_service_image")
    platform.async_register_entity_service("release", {}, "async_service_release")


class GlorbLight(LightEntity):
    _attr_has_entity_name = True
    _attr_name = None
    _attr_should_poll = False
    _attr_supported_color_modes = {ColorMode.RGB}
    _attr_color_mode = ColorMode.RGB
    _attr_supported_features = LightEntityFeature.EFFECT

    def __init__(self, device: GlorbDevice) -> None:
        self.device = device
        self._attr_unique_id = device.mac
        self._attr_device_info = device.device_info
        self._last_rgb = (255, 122, 24)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.device.add_state_listener(self._changed))

    @callback
    def _changed(self) -> None:
        self.async_write_ha_state()

    @property
    def available(self) -> bool:
        return self.device.available

    @property
    def is_on(self) -> bool:
        return bool(self.device.wled_state.get("on"))

    @property
    def brightness(self) -> int:
        return int(self.device.wled_state.get("bri", 0))

    @property
    def rgb_color(self) -> tuple[int, int, int]:
        return self._last_rgb

    @property
    def effect_list(self) -> list[str]:
        d = self.device
        return [
            *(fx.name for fx in REGISTRY.values()),
            *(f"{_LOOK}{name}" for name in sorted(d.saved["looks"])),
            *(f"{_PRESET}{name}" for name in d.wled_presets.values()),
            *(f"{_WLED}{name}" for name in dict.fromkeys(d.wled_effects) if name != "RSVD"),
        ]

    @property
    def effect(self) -> str | None:
        d = self.device
        if d.engine.running and d.engine.current:
            return d.engine.current.name
        seg = (d.wled_state.get("seg") or [{}])[0]
        fx = seg.get("fx")
        if isinstance(fx, int) and fx < len(d.wled_effects):
            return f"{_WLED}{d.wled_effects[fx]}"
        return None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        snap = self.device.engine.snapshot()
        return {
            "streaming": snap["running"],
            "stream_fps": snap["fps"],
            "microphone": snap["audio_active"],
            "fault": self.device.fault,
            "lamp_restarts": self.device.restarts,
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        d = self.device
        payload: dict[str, Any] = {"on": True}
        if ATTR_BRIGHTNESS in kwargs:
            payload["bri"] = kwargs[ATTR_BRIGHTNESS]
        await d.async_wled(payload)
        if ATTR_RGB_COLOR in kwargs:
            self._last_rgb = tuple(kwargs[ATTR_RGB_COLOR])
            r, g, b = self._last_rgb
            await d.async_play("solid", {"color": f"#{r:02x}{g:02x}{b:02x}"})
        elif ATTR_EFFECT in kwargs:
            await self._play_named(kwargs[ATTR_EFFECT])
        elif not d.engine.running:
            choice = d.options[CONF_ON_EFFECT]
            effect_id = d.saved.get("last_effect") if choice == ON_EFFECT_LAST else choice
            if effect_id != ON_EFFECT_LAMP and effect_id in REGISTRY:
                await d.async_play(effect_id)

    async def _play_named(self, name: str) -> None:
        d = self.device
        if name in _NAME_TO_ID:
            await d.async_play(_NAME_TO_ID[name])
        elif name.startswith(_LOOK):
            await d.async_play_look(name[len(_LOOK) :])
        elif name.startswith(_PRESET):
            label = name[len(_PRESET) :]
            for preset, preset_name in d.wled_presets.items():
                if preset_name == label:
                    await d.async_play_wled(preset=int(preset))
                    return
        elif name.startswith(_WLED):
            await d.async_play_wled(fx=d.wled_effects.index(name[len(_WLED) :]))

    async def async_turn_off(self, **kwargs: Any) -> None:
        d = self.device
        d.saved["last_effect"] = d.engine.current.id if d.engine.running and d.engine.current else None
        await d.async_release()
        await d.async_wled({"on": False})

    # Services

    async def async_service_play(self, effect: str, params: dict | None = None, transition: float | None = None) -> None:
        await self.device.async_wled({"on": True})
        await self.device.async_play(effect, params, transition)

    async def async_service_params(self, params: dict) -> None:
        await self.device.async_set_params(params)

    async def async_service_globals(self, **values: Any) -> None:
        self.device.async_set_globals(values)

    async def async_service_alert(
        self, pattern: str, color: str, color2: str, duration: float, opacity: float, direction: str, speed: float, width: float
    ) -> None:
        await self.device.async_alert(pattern, color, color2, duration, opacity, direction, speed, width)

    async def async_service_look(self, name: str) -> None:
        await self.device.async_play_look(name)

    async def async_service_image(self, source: str) -> None:
        await self.device.async_play("picture", {"source": source})

    async def async_service_release(self) -> None:
        await self.device.async_release()
