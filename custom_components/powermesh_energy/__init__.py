"""Powermesh Energie: send selected Home Assistant sensor readings to powermesh.de."""

from __future__ import annotations

from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryError
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PowermeshClient
from .const import CARD_URL, CONF_API_KEY, CONF_MODE, CONF_PAIRING_LINKED, DOMAIN, MODE_LOCAL, PAIRING_STORE, STORAGE_VERSION
from .uploader import PowermeshUploader

PLATFORMS: list[Platform] = [Platform.SENSOR]

type PowermeshConfigEntry = ConfigEntry[PowermeshUploader | None]


async def async_setup_entry(hass: HomeAssistant, entry: PowermeshConfigEntry) -> bool:
    """Start collecting and uploading readings for one powermesh.de account."""
    if hass.http is not None and not hass.data.get(f"{DOMAIN}_card_registered"):
        await hass.http.async_register_static_paths([
            StaticPathConfig(CARD_URL, str(Path(__file__).parent / "frontend" / "powermesh-energy-card.js"), False)
        ])
        hass.data[f"{DOMAIN}_card_registered"] = True
    if entry.data.get(CONF_MODE) == MODE_LOCAL:
        entry.runtime_data = None
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
        entry.async_on_unload(entry.add_update_listener(_async_reload))
        return True
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
    """Stop the uploader and persist pending readings."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    uploader = getattr(entry, "runtime_data", None)
    if unloaded and uploader is not None:
        await uploader.async_stop()
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: PowermeshConfigEntry) -> None:
    """Delete the local offline buffer and account notices when the integration is removed."""
    if entry.data.get(CONF_MODE) == MODE_LOCAL:
        return
    from homeassistant.helpers import issue_registry as ir
    from homeassistant.helpers.storage import Store

    from .const import DOMAIN, STORAGE_VERSION
    from .uploader import ACCOUNT_ISSUES

    if entry.data.get(CONF_PAIRING_LINKED):
        await Store(hass, STORAGE_VERSION, PAIRING_STORE, private=True).async_remove()

    await Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}.buffer").async_remove()
    for issue in ACCOUNT_ISSUES:
        ir.async_delete_issue(hass, DOMAIN, f"{issue}_{entry.entry_id}")


async def _async_reload(hass: HomeAssistant, entry: PowermeshConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
