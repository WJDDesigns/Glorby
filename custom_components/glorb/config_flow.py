"""Add a Glorb by address, or from WLED's network discovery."""
from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_HOST, CONF_MAC, CONF_NAME
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from .const import CONF_FPS, DEFAULT_FPS, DOMAIN, MAX_FPS, MIN_FPS


async def _probe(flow: ConfigFlow, host: str) -> dict[str, Any] | None:
    session = async_get_clientsession(flow.hass)
    try:
        async with session.get(f"http://{host}/json/info", timeout=aiohttp.ClientTimeout(total=6)) as resp:
            return await resp.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
        return None


def _is_glorb(info: dict[str, Any]) -> bool:
    return "GLORB" in str(info.get("ver", "")).upper()


class GlorbConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    _host: str | None = None
    _info: dict[str, Any] | None = None

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return GlorbOptionsFlow()

    def _create(self, host: str, info: dict[str, Any]) -> ConfigFlowResult:
        name = info.get("name") or "Glorb"
        return self.async_create_entry(
            title=name, data={CONF_HOST: host, CONF_MAC: info["mac"], CONF_NAME: name}
        )

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            info = await _probe(self, host)
            if info is None:
                errors["base"] = "cannot_connect"
            elif not _is_glorb(info):
                errors["base"] = "not_glorb"
            else:
                await self.async_set_unique_id(info["mac"])
                self._abort_if_unique_id_configured(updates={CONF_HOST: host})
                return self._create(host, info)
        return self.async_show_form(
            step_id="user", data_schema=vol.Schema({vol.Required(CONF_HOST): str}), errors=errors
        )

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        host = discovery_info.host
        info = await _probe(self, host)
        if info is None or not _is_glorb(info):
            return self.async_abort(reason="not_glorb")
        await self.async_set_unique_id(info["mac"])
        self._abort_if_unique_id_configured(updates={CONF_HOST: host})
        self._host, self._info = host, info
        self.context["title_placeholders"] = {"name": info.get("name") or "Glorb"}
        return await self.async_step_confirm()

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self._create(self._host, self._info)
        return self.async_show_form(
            step_id="confirm", description_placeholders={"host": self._host or ""}
        )


class GlorbOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        current = self.config_entry.options.get(CONF_FPS, DEFAULT_FPS)
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {vol.Required(CONF_FPS, default=current): vol.All(vol.Coerce(int), vol.Range(min=MIN_FPS, max=MAX_FPS))}
            ),
        )
