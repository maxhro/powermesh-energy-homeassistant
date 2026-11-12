"""Problem indicator for local anomaly monitoring."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PowermeshConfigEntry
from .monitor import AnomalyMonitor
from .sensor import monitor_device


async def async_setup_entry(
    hass: HomeAssistant, entry: PowermeshConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create the problem sensor for a monitoring entry."""
    if isinstance(entry.runtime_data, AnomalyMonitor):
        async_add_entities([PowermeshProblemSensor(entry.runtime_data)])


class PowermeshProblemSensor(BinarySensorEntity):
    """On while at least one finding is not acknowledged."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "problem"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, monitor: AnomalyMonitor) -> None:
        self._monitor = monitor
        self._attr_unique_id = f"{monitor.entry.entry_id}_problem"
        self._attr_device_info = monitor_device(monitor)

    @property
    def is_on(self) -> bool:
        return int(self._monitor.snapshot.get("active", 0)) > 0

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._monitor.add_listener(self.async_write_ha_state))
