"""Shared config/options flow steps for local anomaly monitoring."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlowResult
from homeassistant.helpers.selector import (
    AreaSelector,
    AreaSelectorConfig,
    BooleanSelector,
    EntitySelector,
    EntitySelectorConfig,
    LabelSelector,
    LabelSelectorConfig,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from .const import (
    CONF_AREAS,
    CONF_LABELS,
    CONF_MONITORS,
    CONF_NOTIFY_ENTITY,
    CONF_NOTIFY_PERSISTENT,
    CONF_SENSITIVITY,
    DEFAULT_SENSITIVITY,
    MAX_CANDIDATES,
    MAX_MONITORS,
    SENSITIVITY_OPTIONS,
)
from .monitor import Candidate, discover

KIND_LABELS = {
    "power": "W",
    "temperature": "°",
    "humidity": "%",
    "energy": "Σ",
}


def _label(candidate: Candidate) -> str:
    context = " · ".join(part for part in (candidate.area, *candidate.labels[:2]) if part)
    unit = candidate.unit or KIND_LABELS.get(candidate.device_class, "")
    suffix = f" — {context}" if context else ""
    return f"{candidate.name} [{unit}]{suffix}"


class MonitorFlowMixin:
    """Three short steps: structure filter, suggested sensors, notification settings."""

    hass: Any
    _monitor_candidates: list[Candidate]
    _monitor_options: dict[str, Any]

    def _monitor_current(self) -> dict[str, Any]:
        """Return the current options (empty for a new entry)."""
        return {}

    async def _async_finish_monitor(self, options: dict[str, Any]) -> ConfigFlowResult:
        raise NotImplementedError

    async def async_step_monitor(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Optionally limit suggestions to areas and labels."""
        current = self._monitor_current()
        errors: dict[str, str] = {}
        if user_input is not None:
            areas = [item for item in user_input.get(CONF_AREAS, []) if isinstance(item, str)]
            labels = [item for item in user_input.get(CONF_LABELS, []) if isinstance(item, str)]
            candidates = discover(self.hass, areas, labels)[:MAX_CANDIDATES]
            if candidates or current.get(CONF_MONITORS):
                self._monitor_candidates = candidates
                self._monitor_options = {CONF_AREAS: areas, CONF_LABELS: labels}
                return await self.async_step_monitor_select()
            errors["base"] = "no_candidates"
        defaults = user_input if user_input is not None else current
        schema = vol.Schema({
            vol.Optional(CONF_AREAS, description={"suggested_value": defaults.get(CONF_AREAS, [])}):
                AreaSelector(AreaSelectorConfig(multiple=True)),
            vol.Optional(CONF_LABELS, description={"suggested_value": defaults.get(CONF_LABELS, [])}):
                LabelSelector(LabelSelectorConfig(multiple=True)),
        })
        return self.async_show_form(step_id="monitor", data_schema=schema, errors=errors)  # type: ignore[attr-defined]

    async def async_step_monitor_select(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Confirm the suggested sensors; nothing is monitored without confirmation."""
        current = self._monitor_current()
        existing = [item for item in current.get(CONF_MONITORS, []) if isinstance(item, str)]
        options = [SelectOptionDict(value=item.entity_id, label=_label(item)) for item in self._monitor_candidates]
        known = {option["value"] for option in options}
        options.extend(SelectOptionDict(value=item, label=item) for item in existing if item not in known)
        errors: dict[str, str] = {}
        if user_input is not None:
            selected = list(dict.fromkeys(user_input.get(CONF_MONITORS, [])))
            if not selected:
                errors["base"] = "no_monitors"
            elif len(selected) > MAX_MONITORS:
                errors["base"] = "too_many_monitors"
            else:
                self._monitor_options[CONF_MONITORS] = selected
                return await self.async_step_monitor_settings()
            suggested = selected
        else:
            suggested = existing or [option["value"] for option in options[:MAX_MONITORS]]
        schema = vol.Schema({
            vol.Optional(CONF_MONITORS, description={"suggested_value": suggested}): SelectSelector(
                SelectSelectorConfig(options=options, multiple=True, mode=SelectSelectorMode.LIST)
            ),
        })
        return self.async_show_form(  # type: ignore[attr-defined]
            step_id="monitor_select", data_schema=schema, errors=errors,
            description_placeholders={"count": str(len(self._monitor_candidates)), "max": str(MAX_MONITORS)},
        )

    async def async_step_monitor_settings(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Choose sensitivity and optional local notifications."""
        current = self._monitor_current()
        if user_input is not None:
            sensitivity = user_input.get(CONF_SENSITIVITY)
            options = self._monitor_options | {
                CONF_SENSITIVITY: sensitivity if sensitivity in SENSITIVITY_OPTIONS else DEFAULT_SENSITIVITY,
                CONF_NOTIFY_PERSISTENT: user_input.get(CONF_NOTIFY_PERSISTENT) is True,
            }
            notify_entity = user_input.get(CONF_NOTIFY_ENTITY)
            if isinstance(notify_entity, str) and notify_entity:
                options[CONF_NOTIFY_ENTITY] = notify_entity
            return await self._async_finish_monitor(options)
        schema = vol.Schema({
            vol.Required(CONF_SENSITIVITY, default=current.get(CONF_SENSITIVITY, DEFAULT_SENSITIVITY)): SelectSelector(
                SelectSelectorConfig(
                    options=list(SENSITIVITY_OPTIONS), translation_key="sensitivity", mode=SelectSelectorMode.LIST
                )
            ),
            vol.Required(CONF_NOTIFY_PERSISTENT, default=current.get(CONF_NOTIFY_PERSISTENT, True)): BooleanSelector(),
            vol.Optional(CONF_NOTIFY_ENTITY, description={"suggested_value": current.get(CONF_NOTIFY_ENTITY)}):
                EntitySelector(EntitySelectorConfig(domain="notify")),
        })
        return self.async_show_form(step_id="monitor_settings", data_schema=schema)  # type: ignore[attr-defined]
