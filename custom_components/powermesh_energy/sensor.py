"""Diagnostic sensors showing the upload state."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PowermeshConfigEntry
from .const import CONF_ROLES, DOMAIN, STATUSES, VERSION
from .monitor import AnomalyMonitor
from .uploader import PowermeshUploader


async def async_setup_entry(
    hass: HomeAssistant, entry: PowermeshConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create the diagnostic sensors."""
    uploader = entry.runtime_data
    if isinstance(uploader, AnomalyMonitor):
        async_add_entities([PowermeshFindingsSensor(uploader)])
        return
    if uploader is None:
        async_add_entities([PowermeshOverviewSensor(entry)])
        return
    async_add_entities(
        [
            PowermeshStatusSensor(uploader),
            PowermeshPendingSensor(uploader),
            PowermeshLastUploadSensor(uploader),
        ]
    )


class PowermeshOverviewSensor(SensorEntity):
    """Expose only selected source references for the local dashboard card."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "Energieübersicht"
    _attr_icon = "mdi:home-lightning-bolt-outline"
    _attr_native_value = "local"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, entry: PowermeshConfigEntry) -> None:
        self._attr_unique_id = f"{entry.entry_id}_overview"
        self._attr_extra_state_attributes = {CONF_ROLES: dict(entry.options.get(CONF_ROLES, {}))}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)}, name="Powermesh Energie",
            manufacturer="Powermesh", entry_type=DeviceEntryType.SERVICE, sw_version=VERSION,
        )


def monitor_device(monitor: AnomalyMonitor) -> DeviceInfo:
    """Return the shared service device of a monitoring entry."""
    return DeviceInfo(
        identifiers={(DOMAIN, monitor.entry.entry_id)}, name="Powermesh Auffälligkeiten",
        manufacturer="Powermesh", entry_type=DeviceEntryType.SERVICE, sw_version=VERSION,
    )


class PowermeshFindingsSensor(SensorEntity):
    """Number of open findings, with local details for the dashboard card."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "findings"
    _attr_icon = "mdi:alert-decagram-outline"
    _unrecorded_attributes = frozenset({"findings", "monitors", "recent", "sensitivity"})

    def __init__(self, monitor: AnomalyMonitor) -> None:
        self._monitor = monitor
        self._attr_unique_id = f"{monitor.entry.entry_id}_findings"
        self._attr_device_info = monitor_device(monitor)

    @property
    def native_value(self) -> int:
        return int(self._monitor.snapshot.get("active", 0))

    @property
    def extra_state_attributes(self) -> dict:
        snapshot = self._monitor.snapshot
        return {key: snapshot.get(key) for key in ("findings", "monitors", "recent", "sensitivity")}

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._monitor.add_listener(self.async_write_ha_state))


class _PowermeshSensor(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, uploader: PowermeshUploader, key: str) -> None:
        self._uploader = uploader
        self._attr_translation_key = key
        self._attr_unique_id = f"{uploader.entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, uploader.entry.entry_id)},
            name="powermesh.de",
            manufacturer="Powermesh",
            entry_type=DeviceEntryType.SERVICE,
            configuration_url=uploader.client.base_url,
            sw_version=VERSION,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._uploader.async_add_listener(self.async_write_ha_state))


class PowermeshStatusSensor(_PowermeshSensor):
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = STATUSES

    def __init__(self, uploader: PowermeshUploader) -> None:
        super().__init__(uploader, "upload_status")

    @property
    def native_value(self) -> str:
        return self._uploader.status

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        return {
            "last_error": self._uploader.last_error,
            "accepted_total": self._uploader.accepted_total,
            "dropped_total": self._uploader.dropped_total,
            "buffer_limit_readings": self._uploader.buffer_limit,
            "entities": self._uploader.entities,
            "integration_version": VERSION,
            "latest_integration_version": self._uploader.latest_version,
            "server_release": self._uploader.server_release,
        }


class PowermeshPendingSensor(_PowermeshSensor):
    _attr_native_unit_of_measurement = "readings"

    def __init__(self, uploader: PowermeshUploader) -> None:
        super().__init__(uploader, "pending_readings")

    @property
    def native_value(self) -> int:
        return self._uploader.pending


class PowermeshLastUploadSensor(_PowermeshSensor):
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, uploader: PowermeshUploader) -> None:
        super().__init__(uploader, "last_upload")

    @property
    def native_value(self) -> datetime | None:
        return self._uploader.last_upload
