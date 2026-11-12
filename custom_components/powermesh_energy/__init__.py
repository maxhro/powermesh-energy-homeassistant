"""Powermesh Energie: local anomaly monitoring for Home Assistant sensors.

The powermesh.de REST transfer remains in this package but is disabled by
``const.CLOUD_TRANSFER_ENABLED`` for the local monitoring prototype.
"""

from __future__ import annotations

from pathlib import Path

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ConfigEntryError
from homeassistant.helpers import config_validation as cv, issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from . import const
from .api import PowermeshClient
from .const import (
    CARD_URL,
    CONF_API_KEY,
    CONF_MODE,
    CONF_PAIRING_LINKED,
    DOMAIN,
    MODE_LOCAL,
    MODE_MONITOR,
    PAIRING_STORE,
    STORAGE_VERSION,
    VERSION,
)
from .monitor import AnomalyMonitor
from .uploader import PowermeshUploader

PLATFORMS: list[Platform] = [Platform.SENSOR]
MONITOR_PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.BINARY_SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
SERVICE_ACKNOWLEDGE = "acknowledge"
ATTR_FINDING_ID = "finding_id"
DISABLED_ISSUE = "cloud_transfer_disabled"

type PowermeshConfigEntry = ConfigEntry[PowermeshUploader | AnomalyMonitor | None]


def _is_cloud(entry: ConfigEntry) -> bool:
    return entry.data.get(CONF_MODE) not in (MODE_LOCAL, MODE_MONITOR)


def _platforms(entry: ConfigEntry) -> list[Platform]:
    if entry.data.get(CONF_MODE) == MODE_MONITOR:
        return MONITOR_PLATFORMS
    if _is_cloud(entry) and not const.CLOUD_TRANSFER_ENABLED:
        return []
    return PLATFORMS


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the acknowledge service once."""

    async def _acknowledge(call: ServiceCall) -> ServiceResponse:
        finding_id = call.data.get(ATTR_FINDING_ID)
        count = 0
        for entry in hass.config_entries.async_loaded_entries(DOMAIN):
            monitor = getattr(entry, "runtime_data", None)
            if isinstance(monitor, AnomalyMonitor):
                count += monitor.acknowledge(finding_id)
        return {"acknowledged": count}

    hass.services.async_register(
        DOMAIN,
        SERVICE_ACKNOWLEDGE,
        _acknowledge,
        schema=vol.Schema({vol.Optional(ATTR_FINDING_ID): vol.All(cv.string, vol.Length(min=1, max=255))}),
        supports_response=SupportsResponse.OPTIONAL,
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: PowermeshConfigEntry) -> bool:
    """Start local monitoring, the local overview or (when enabled) the cloud uploader."""
    if hass.http is not None and not hass.data.get(f"{DOMAIN}_card_registered"):
        await hass.http.async_register_static_paths([
            StaticPathConfig(CARD_URL, str(Path(__file__).parent / "frontend" / "powermesh-energy-card.js"), False)
        ])
        if "frontend" in hass.config.components:
            # Version query busts browser caches after updates; no manual dashboard resource is needed.
            add_extra_js_url(hass, f"{CARD_URL}?v={VERSION}")
        hass.data[f"{DOMAIN}_card_registered"] = True
    mode = entry.data.get(CONF_MODE)
    if mode == MODE_MONITOR:
        monitor = AnomalyMonitor(hass, entry)
        entry.runtime_data = monitor
        await monitor.async_start()
        await hass.config_entries.async_forward_entry_setups(entry, MONITOR_PLATFORMS)
        entry.async_on_unload(entry.add_update_listener(_async_reload))
        return True
    if mode == MODE_LOCAL:
        entry.runtime_data = None
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
        entry.async_on_unload(entry.add_update_listener(_async_reload))
        return True
    if not const.CLOUD_TRANSFER_ENABLED:
        # Keep credentials and any local buffer untouched; nothing is sent.
        entry.runtime_data = None
        ir.async_create_issue(
            hass, DOMAIN, f"{DISABLED_ISSUE}_{entry.entry_id}", is_fixable=False,
            severity=ir.IssueSeverity.WARNING, translation_key=DISABLED_ISSUE,
        )
        return True
    ir.async_delete_issue(hass, DOMAIN, f"{DISABLED_ISSUE}_{entry.entry_id}")
    api_key = entry.data.get(CONF_API_KEY)
    if not isinstance(api_key, str):
        raise ConfigEntryError(
            "This older integration entry uses an incompatible connection format. "
            "Keep any pending local readings safe before replacing the entry."
        )
    client = PowermeshClient(async_get_clientsession(hass), api_key)
    uploader = PowermeshUploader(hass, entry, client)
    entry.runtime_data = uploader
    await uploader.async_start()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    if entry.data.get(CONF_PAIRING_LINKED):
        from homeassistant.helpers.storage import Store

        await Store(hass, STORAGE_VERSION, PAIRING_STORE, private=True).async_remove()
        hass.config_entries.async_update_entry(
            entry, data={key: value for key, value in entry.data.items() if key != CONF_PAIRING_LINKED}
        )
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: PowermeshConfigEntry) -> bool:
    """Stop monitoring or the uploader and persist local state."""
    platforms = _platforms(entry)
    unloaded = await hass.config_entries.async_unload_platforms(entry, platforms) if platforms else True
    runtime = getattr(entry, "runtime_data", None)
    if unloaded and runtime is not None:
        await runtime.async_stop()
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: PowermeshConfigEntry) -> None:
    """Delete local state and notices when the integration entry is removed."""
    mode = entry.data.get(CONF_MODE)
    if mode == MODE_LOCAL:
        return
    if mode == MODE_MONITOR:
        await AnomalyMonitor(hass, entry).async_remove()
        return
    from homeassistant.helpers.storage import Store

    from .uploader import ACCOUNT_ISSUES

    if entry.data.get(CONF_PAIRING_LINKED):
        await Store(hass, STORAGE_VERSION, PAIRING_STORE, private=True).async_remove()

    await Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}.buffer").async_remove()
    for issue in (*ACCOUNT_ISSUES, DISABLED_ISSUE):
        ir.async_delete_issue(hass, DOMAIN, f"{issue}_{entry.entry_id}")


async def _async_reload(hass: HomeAssistant, entry: PowermeshConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
