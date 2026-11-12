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
    TextSelector,
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
from .monitor import Candidate, classify, discover

CONF_SEARCH = "search"
CONF_BULK = "bulk"
BULK_KEEP = "keep"
BULK_ALL = "all"
BULK_NONE = "none"
BULK_OPTIONS = (BULK_KEEP, BULK_ALL, BULK_NONE)
CONF_TYPES = "types"
TYPE_OTHER = "other"
TYPE_ORDER = ("power", "energy", "temperature", "humidity", TYPE_OTHER)

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


def _matching(
    options: list[SelectOptionDict], search: str, kinds: dict[str, str], types: list[str]
) -> list[SelectOptionDict]:
    """Options of the chosen types whose label or entity ID contains every search term."""
    terms = search.casefold().split()
    return [
        option for option in options
        if (not types or kinds[option["value"]] in types)
        and all(term in f"{option['label']} {option['value']}".casefold() for term in terms)
    ]


class MonitorFlowMixin:
    """Three short steps: structure filter, suggested sensors, notification settings."""

    hass: Any
    _monitor_candidates: list[Candidate]
    _monitor_options: dict[str, Any]
    _monitor_selected: list[str] | None = None
    _monitor_search: str = ""
    _monitor_types: list[str] = []

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
                self._monitor_selected = None
                self._monitor_search = ""
                self._monitor_types = []
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
        """Confirm the suggested sensors; search and bulk selection affect only the displayed sensors."""
        current = self._monitor_current()
        existing = [item for item in current.get(CONF_MONITORS, []) if isinstance(item, str)]
        options = [SelectOptionDict(value=item.entity_id, label=_label(item)) for item in self._monitor_candidates]
        kinds = {item.entity_id: item.device_class for item in self._monitor_candidates}
        known = {option["value"] for option in options}
        for item in existing:
            if item not in known:
                state = self.hass.states.get(item)
                rule = classify(state.attributes) if state is not None else None
                kinds[item] = rule[1] if rule else TYPE_OTHER
                options.append(SelectOptionDict(value=item, label=item))
        # Group the list by entity type; the sort is stable within a type.
        options.sort(key=lambda option: TYPE_ORDER.index(kinds[option["value"]]) if kinds[option["value"]] in TYPE_ORDER else len(TYPE_ORDER))
        present = [kind for kind in TYPE_ORDER if kind in kinds.values()]
        values = [option["value"] for option in options]
        if self._monitor_selected is None:
            self._monitor_selected = existing or values[:MAX_MONITORS]
            self._monitor_search = ""
            self._monitor_types = []
        errors: dict[str, str] = {}
        if user_input is not None:
            shown = {option["value"] for option in _matching(options, self._monitor_search, kinds, self._monitor_types)}
            submitted = {item for item in user_input.get(CONF_MONITORS, []) if item in shown}
            selected = {item for item in self._monitor_selected if item not in shown} | submitted
            search = str(user_input.get(CONF_SEARCH, "")).strip()[:100]
            types = [kind for kind in present if kind in user_input.get(CONF_TYPES, [])]
            bulk = user_input.get(CONF_BULK, BULK_KEEP)
            target = {option["value"] for option in _matching(options, search, kinds, types)}
            if bulk == BULK_ALL:
                selected |= target
            elif bulk == BULK_NONE:
                selected -= target
            self._monitor_selected = [item for item in values if item in selected]
            if search != self._monitor_search or types != self._monitor_types or bulk in (BULK_ALL, BULK_NONE):
                # Changing a filter or applying a bulk action redisplays the list instead of continuing.
                self._monitor_search = search
                self._monitor_types = types
            elif not selected:
                errors["base"] = "no_monitors"
            elif len(selected) > MAX_MONITORS:
                errors["base"] = "too_many_monitors"
            else:
                self._monitor_options[CONF_MONITORS] = list(self._monitor_selected)
                return await self.async_step_monitor_settings()
        displayed = _matching(options, self._monitor_search, kinds, self._monitor_types)
        shown = {option["value"] for option in displayed}
        schema = vol.Schema({
            vol.Optional(CONF_SEARCH, description={"suggested_value": self._monitor_search}): TextSelector(),
            vol.Optional(CONF_TYPES, description={"suggested_value": self._monitor_types}): SelectSelector(
                SelectSelectorConfig(options=present, multiple=True, translation_key="entity_type", mode=SelectSelectorMode.LIST)
            ),
            vol.Required(CONF_BULK, default=BULK_KEEP): SelectSelector(
                SelectSelectorConfig(options=list(BULK_OPTIONS), translation_key="bulk_selection", mode=SelectSelectorMode.DROPDOWN)
            ),
            vol.Optional(CONF_MONITORS, description={"suggested_value": [
                item for item in self._monitor_selected if item in shown
            ]}): SelectSelector(
                SelectSelectorConfig(options=displayed, multiple=True, mode=SelectSelectorMode.LIST)
            ),
        })
        return self.async_show_form(  # type: ignore[attr-defined]
            step_id="monitor_select", data_schema=schema, errors=errors,
            description_placeholders={
                "count": str(len(options)), "shown": str(len(displayed)),
                "selected": str(len(self._monitor_selected)), "max": str(MAX_MONITORS),
            },
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
