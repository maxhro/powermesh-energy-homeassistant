"""Local, owner-confirmed anomaly monitoring for selected Home Assistant sensors."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, field, fields
from datetime import timedelta
import logging
import math
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
    floor_registry as fr,
    label_registry as lr,
)
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_MONITORS,
    CONF_NOTIFY_ENTITY,
    CONF_NOTIFY_PERSISTENT,
    CONF_SENSITIVITY,
    DEFAULT_SENSITIVITY,
    DOMAIN,
    MAX_MONITORS,
    SENSITIVITY_OPTIONS,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

KIND_BASELINE = "baseline"
KIND_COUNTER = "counter"
FINDING_DEVIATION = "deviation"
FINDING_COUNTER_GLITCH = "counter_glitch"
FINDING_COUNTER_DECREASE = "counter_decrease"
FINDING_NO_DATA = "no_data"
DATA_QUALITY = frozenset({FINDING_COUNTER_GLITCH, FINDING_COUNTER_DECREASE, FINDING_NO_DATA})
EVENT_FINDINGS = frozenset({FINDING_COUNTER_GLITCH, FINDING_COUNTER_DECREASE})

TAU_SECONDS = 12 * 3600
LEARN_SECONDS = 24 * 3600
MIN_SAMPLES = 30
MAX_GAP_SECONDS = 6 * 3600
MIN_DEVIATION_SECONDS = 600
NO_DATA_SECONDS = 1800
GLITCH_WINDOW_SECONDS = 1800
RESET_RATIO = 0.05
CLEAR_RATIO = 0.75
RELATIVE_FLOOR = 0.05
NOTIFY_COOLDOWN_SECONDS = 6 * 3600
PUBLISH_INTERVAL_SECONDS = 600
MAX_RECENT = 20
TICK_INTERVAL = timedelta(seconds=60)
SAVE_DELAY_SECONDS = 120

POWER_UNITS = {"W": 1.0, "kW": 1000.0, "MW": 1_000_000.0}
ENERGY_UNITS = frozenset({"Wh", "kWh", "MWh"})
POWER_FLOOR_WATTS = 10.0
BASELINE_FLOORS = {"temperature": {"°C": 0.5, "°F": 1.0, "K": 0.5}, "humidity": {"%": 2.0}}


@dataclass(frozen=True)
class Candidate:
    """A sensor that can be monitored with a known KPI rule."""

    entity_id: str
    name: str
    area: str | None
    area_id: str | None
    floor: str | None
    labels: tuple[str, ...]
    kind: str
    device_class: str
    unit: str | None


def classify(attributes: Mapping[str, Any]) -> tuple[str, str] | None:
    """Return (rule kind, device class) for supported sensor metadata."""
    device_class = attributes.get("device_class")
    unit = attributes.get("unit_of_measurement")
    state_class = attributes.get("state_class")
    if device_class == "power" and unit in POWER_UNITS and state_class in (None, "measurement"):
        return KIND_BASELINE, "power"
    if (
        device_class in BASELINE_FLOORS
        and unit in BASELINE_FLOORS[device_class]
        and state_class in (None, "measurement")
    ):
        return KIND_BASELINE, device_class
    if device_class == "energy" and unit in ENERGY_UNITS and state_class == "total_increasing":
        return KIND_COUNTER, "energy"
    return None


def numeric(state: State | None) -> float | None:
    """Return a finite number, or None for missing and non-numeric states."""
    if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
        return None
    try:
        value = float(state.state)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _floor(device_class: str | None, unit: str | None) -> float:
    if device_class == "power" and unit in POWER_UNITS:
        return POWER_FLOOR_WATTS / POWER_UNITS[unit]
    return BASELINE_FLOORS.get(device_class or "", {}).get(unit or "", 1e-6)


def _context(hass: HomeAssistant, entity_id: str) -> dict[str, Any]:
    """Return display name, area, floor and label context from the registries."""
    entry = er.async_get(hass).async_get(entity_id)
    device = dr.async_get(hass).async_get(entry.device_id) if entry and entry.device_id else None
    area_id = (entry.area_id if entry else None) or (device.area_id if device else None)
    area = ar.async_get(hass).async_get_area(area_id) if area_id else None
    floor = fr.async_get(hass).async_get_floor(area.floor_id) if area and area.floor_id else None
    label_ids = set(getattr(entry, "labels", ()) or ()) | set(getattr(device, "labels", ()) or ())
    if area is not None:
        label_ids |= set(getattr(area, "labels", ()) or ())
    labels = lr.async_get(hass)
    label_names = sorted(
        label.name for label_id in label_ids if (label := labels.async_get_label(label_id)) is not None
    )
    state = hass.states.get(entity_id)
    name = state.name if state is not None else (entry.name or entry.original_name if entry else None)
    return {
        "name": name if isinstance(name, str) and name else entity_id,
        "area_id": area_id,
        "area": area.name if area else None,
        "floor": floor.name if floor else None,
        "label_ids": label_ids,
        "labels": tuple(label_names),
        "platform": entry.platform if entry else None,
        "disabled": bool(entry and entry.disabled_by),
    }


def discover(
    hass: HomeAssistant, area_ids: Iterable[str] = (), label_ids: Iterable[str] = ()
) -> list[Candidate]:
    """Suggest monitorable sensors, optionally limited to areas and labels."""
    area_filter = set(area_ids)
    label_filter = set(label_ids)
    found = []
    for state in hass.states.async_all("sensor"):
        rule = classify(state.attributes)
        if rule is None:
            continue
        context = _context(hass, state.entity_id)
        if context["platform"] == DOMAIN or context["disabled"]:
            continue
        if area_filter and context["area_id"] not in area_filter:
            continue
        if label_filter and not context["label_ids"] & label_filter:
            continue
        found.append(Candidate(
            entity_id=state.entity_id,
            name=context["name"],
            area=context["area"],
            area_id=context["area_id"],
            floor=context["floor"],
            labels=context["labels"],
            kind=rule[0],
            device_class=rule[1],
            unit=state.attributes.get("unit_of_measurement"),
        ))
    found.sort(key=lambda item: ((item.area or "~").casefold(), item.name.casefold(), item.entity_id))
    return found


@dataclass
class Track:
    """Bounded detector state for one monitored sensor."""

    entity_id: str
    kind: str | None = None
    device_class: str | None = None
    unit: str | None = None
    mean: float | None = None
    dev: float = 0.0
    samples: int = 0
    observed: float = 0.0
    last_value: float | None = None
    last_ts: float | None = None
    missing_since: float | None = None
    pending_since: float | None = None
    drop: dict[str, float] | None = None
    score: float | None = None
    last_reset: float | None = None
    notified: dict[str, float] = field(default_factory=dict)
    findings: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def restore(cls, entity_id: str, data: Any) -> Track:
        """Restore persisted state, falling back to a fresh track."""
        if not isinstance(data, dict):
            return cls(entity_id)
        names = {item.name for item in fields(cls)} - {"entity_id"}
        try:
            track = cls(entity_id, **{key: value for key, value in data.items() if key in names})
        except TypeError:
            return cls(entity_id)
        if not isinstance(track.findings, dict) or not isinstance(track.notified, dict):
            return cls(entity_id)
        if track.drop is not None and not isinstance(track.drop, dict):
            track.drop = None
        # Outages and pending checks never span a restart.
        track.missing_since = None
        track.pending_since = None
        return track

    def reset_learning(self) -> None:
        """Start learning again after a unit or classification change."""
        self.mean = None
        self.dev = 0.0
        self.samples = 0
        self.observed = 0.0
        self.pending_since = None
        self.score = None


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 3)
    return value


def _iso(timestamp: float) -> str:
    return dt_util.utc_from_timestamp(timestamp).isoformat()


class AnomalyMonitor:
    """Evaluate confirmed sensors locally and publish findings."""

    def __init__(self, hass: HomeAssistant, entry: Any) -> None:
        self.hass = hass
        self.entry = entry
        options = entry.options
        self.entity_ids: list[str] = [
            entity_id for entity_id in options.get(CONF_MONITORS, []) if isinstance(entity_id, str)
        ][:MAX_MONITORS]
        sensitivity = options.get(CONF_SENSITIVITY, DEFAULT_SENSITIVITY)
        self.sensitivity = sensitivity if sensitivity in SENSITIVITY_OPTIONS else DEFAULT_SENSITIVITY
        self.threshold = SENSITIVITY_OPTIONS[self.sensitivity]
        self._notify_persistent = options.get(CONF_NOTIFY_PERSISTENT) is True
        notify_entity = options.get(CONF_NOTIFY_ENTITY)
        self._notify_entity = notify_entity if isinstance(notify_entity, str) and notify_entity.startswith("notify.") else None
        self._store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}.monitor", private=True
        )
        self._tracks: dict[str, Track] = {entity_id: Track(entity_id) for entity_id in self.entity_ids}
        self._meta: dict[str, dict[str, Any]] = {}
        self._recent: list[dict[str, Any]] = []
        self._listeners: list[Callable[[], None]] = []
        self._unsubs: list[Callable[[], None]] = []
        self._signature: tuple[Any, ...] = ()
        self._published_at = 0.0
        self.snapshot: dict[str, Any] = {}
        self._publish(dt_util.utcnow().timestamp(), force=True)

    async def async_start(self) -> None:
        """Restore detector state and subscribe to the confirmed sensors only."""
        stored = await self._store.async_load()
        if isinstance(stored, dict):
            tracks = stored.get("tracks")
            if isinstance(tracks, dict):
                for entity_id in self.entity_ids:
                    self._tracks[entity_id] = Track.restore(entity_id, tracks.get(entity_id))
            recent = stored.get("recent")
            if isinstance(recent, list):
                self._recent = [item for item in recent if isinstance(item, dict)][:MAX_RECENT]
        self._meta = {entity_id: _context(self.hass, entity_id) for entity_id in self.entity_ids}
        for entity_id in self.entity_ids:
            if (state := self.hass.states.get(entity_id)) is not None:
                self._observe_state(entity_id, state)
        if self.entity_ids:
            self._unsubs.append(
                async_track_state_change_event(self.hass, self.entity_ids, self._handle_event)
            )
        self._unsubs.append(async_track_time_interval(self.hass, self._handle_tick, TICK_INTERVAL))
        self.tick(dt_util.utcnow().timestamp())

    async def async_stop(self) -> None:
        """Unsubscribe and persist the bounded detector state."""
        while self._unsubs:
            self._unsubs.pop()()
        await self._store.async_save(self._data())

    async def async_remove(self) -> None:
        """Delete the persisted detector state and open notifications."""
        for entity_id, track in self._tracks.items():
            for kind in track.findings:
                persistent_notification.async_dismiss(self.hass, self._notification_id(entity_id, kind))
        await self._store.async_remove()

    @callback
    def add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Register an entity update callback."""
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    @callback
    def _handle_event(self, event: Event[EventStateChangedData]) -> None:
        new_state = event.data["new_state"]
        if new_state is None:
            self.observe(event.data["entity_id"], None, dt_util.utcnow().timestamp())
        else:
            self._observe_state(event.data["entity_id"], new_state)
        self._publish(dt_util.utcnow().timestamp())

    @callback
    def _handle_tick(self, now: Any) -> None:
        self.tick(now.timestamp())

    @callback
    def _observe_state(self, entity_id: str, state: State) -> None:
        self.observe(entity_id, numeric(state), state.last_updated.timestamp(), state.attributes)

    @callback
    def observe(
        self, entity_id: str, value: float | None, ts: float, attributes: Mapping[str, Any] | None = None
    ) -> None:
        """Feed one observation; timestamps are UTC seconds."""
        track = self._tracks.get(entity_id)
        if track is None or (track.last_ts is not None and ts < track.last_ts):
            return
        if value is None:
            if track.missing_since is None:
                track.missing_since = ts
            self._save()
            return
        after_gap = track.missing_since is not None
        if after_gap:
            track.missing_since = None
            self._resolve(track, FINDING_NO_DATA, ts)
        self._apply_metadata(track, attributes)
        if track.kind == KIND_COUNTER:
            self._observe_counter(track, value, ts)
        elif track.kind == KIND_BASELINE:
            self._learn(track, ts, after_gap)
        track.last_value = value
        track.last_ts = ts
        if track.kind == KIND_BASELINE:
            self._evaluate(track, value, ts)
            self._check_pending(track, ts)
        self._save()

    @callback
    def tick(self, now: float) -> None:
        """Evaluate durations that need no new state change."""
        for track in self._tracks.values():
            if (
                track.missing_since is not None
                and now - track.missing_since >= NO_DATA_SECONDS
                and FINDING_NO_DATA not in track.findings
            ):
                self._raise(track, FINDING_NO_DATA, now, {"missing_since": _iso(track.missing_since)})
            if track.kind == KIND_BASELINE:
                self._check_pending(track, now)
            if track.drop is not None and now - track.drop["at"] >= GLITCH_WINDOW_SECONDS:
                self._finish_drop(track)
        self._publish(now)

    @callback
    def acknowledge(self, finding_id: str | None = None) -> int:
        """Acknowledge one finding, or all findings when no id is given."""
        now = dt_util.utcnow().timestamp()
        count = 0
        for track in self._tracks.values():
            for kind, finding in list(track.findings.items()):
                if finding_id is not None and finding["id"] != finding_id:
                    continue
                count += 1
                persistent_notification.async_dismiss(self.hass, self._notification_id(track.entity_id, kind))
                if kind in EVENT_FINDINGS:
                    self._resolve(track, kind, now, acknowledged=True)
                else:
                    finding["acknowledged"] = True
        if count:
            self._save()
            self._publish(now, force=True)
        return count

    def _apply_metadata(self, track: Track, attributes: Mapping[str, Any] | None) -> None:
        if attributes is None:
            return
        rule = classify(attributes)
        unit = attributes.get("unit_of_measurement")
        if rule is not None and (track.kind, track.device_class) != rule:
            track.kind, track.device_class = rule
            track.reset_learning()
            track.drop = None
        if isinstance(unit, str) and unit != track.unit:
            if track.unit is not None:
                track.reset_learning()
                track.drop = None
                track.last_value = None
            track.unit = unit

    def _blocks_learning(self, track: Track) -> bool:
        finding = track.findings.get(FINDING_DEVIATION)
        if finding is not None:
            return finding.get("acknowledged") is not True
        return track.pending_since is not None

    def _learn(self, track: Track, ts: float, after_gap: bool) -> None:
        if track.mean is None:
            return
        if after_gap or track.last_value is None or track.last_ts is None or ts <= track.last_ts:
            return
        if self._blocks_learning(track):
            return
        # The previous value held until now (Home Assistant reports changes only).
        elapsed = min(ts - track.last_ts, MAX_GAP_SECONDS)
        alpha = 1.0 - math.exp(-elapsed / TAU_SECONDS)
        error = track.last_value - track.mean
        track.mean += alpha * error
        track.dev += alpha * (abs(error) - track.dev)
        track.observed += elapsed
        track.samples += 1

    def _ready(self, track: Track) -> bool:
        return track.mean is not None and track.samples >= MIN_SAMPLES and track.observed >= LEARN_SECONDS

    def _scale(self, track: Track) -> float:
        assert track.mean is not None
        return max(track.dev, _floor(track.device_class, track.unit), RELATIVE_FLOOR * abs(track.mean))

    def _evaluate(self, track: Track, value: float, ts: float) -> None:
        if track.mean is None:
            track.mean = value
            track.dev = 0.0
        if not self._ready(track):
            track.score = None
            track.pending_since = None
            return
        track.score = abs(value - track.mean) / self._scale(track)
        if track.score >= self.threshold:
            if track.pending_since is None:
                track.pending_since = ts
        elif track.score < self.threshold * CLEAR_RATIO:
            track.pending_since = None
            self._resolve(track, FINDING_DEVIATION, ts)

    def _check_pending(self, track: Track, now: float) -> None:
        if (
            track.pending_since is None
            or FINDING_DEVIATION in track.findings
            or now - track.pending_since < MIN_DEVIATION_SECONDS
            or track.mean is None
            or track.last_value is None
        ):
            return
        scale = self._scale(track)
        self._raise(track, FINDING_DEVIATION, track.pending_since, {
            "value": track.last_value,
            "reference": track.mean,
            "band_low": track.mean - self.threshold * scale,
            "band_high": track.mean + self.threshold * scale,
            "direction": "above" if track.last_value > track.mean else "below",
            "unit": track.unit,
        })

    def _observe_counter(self, track: Track, value: float, ts: float) -> None:
        if track.drop is not None:
            before = track.drop["before"]
            if value >= before - max(1e-6, abs(before) * 1e-6):
                self._raise(track, FINDING_COUNTER_GLITCH, track.drop["at"], {
                    "before": before, "low": track.drop["low"], "unit": track.unit,
                    "duration_seconds": ts - track.drop["at"],
                })
                track.drop = None
            else:
                track.drop["low"] = min(track.drop["low"], value)
            return
        previous = track.last_value
        if previous is not None and value < previous - max(1e-6, abs(previous) * 1e-6):
            track.drop = {"before": previous, "low": value, "at": ts}

    def _finish_drop(self, track: Track) -> None:
        drop = track.drop
        track.drop = None
        if drop is None:
            return
        if drop["low"] <= abs(drop["before"]) * RESET_RATIO:
            # A lasting drop to (almost) zero is the documented reset of a total_increasing counter.
            track.last_reset = drop["at"]
            return
        self._raise(track, FINDING_COUNTER_DECREASE, drop["at"], {
            "before": drop["before"], "after": drop["low"], "unit": track.unit,
        })

    def _raise(self, track: Track, kind: str, ts: float, details: dict[str, Any]) -> None:
        if kind in track.findings:
            return
        finding = {
            "id": f"{kind}:{track.entity_id}:{int(ts)}",
            "type": kind,
            "category": "data_quality" if kind in DATA_QUALITY else "behavior",
            "entity_id": track.entity_id,
            "since": _iso(ts),
            "acknowledged": False,
            **{key: _round(value) for key, value in details.items()},
        }
        track.findings[kind] = finding
        self._notify(track, finding, ts)
        self._save()

    def _resolve(self, track: Track, kind: str, ts: float, *, acknowledged: bool = False) -> None:
        finding = track.findings.pop(kind, None)
        if finding is None:
            return
        persistent_notification.async_dismiss(self.hass, self._notification_id(track.entity_id, kind))
        resolved = dict(finding, resolved=_iso(ts), acknowledged=acknowledged or finding.get("acknowledged", False))
        self._recent = [resolved, *self._recent][:MAX_RECENT]
        self._save()

    def _notification_id(self, entity_id: str, kind: str) -> str:
        return f"{DOMAIN}_{self.entry.entry_id}_{kind}_{entity_id}"

    def _notify(self, track: Track, finding: dict[str, Any], ts: float) -> None:
        if not self._notify_persistent and self._notify_entity is None:
            return
        last = track.notified.get(finding["type"])
        if isinstance(last, (int, float)) and ts - last < NOTIFY_COOLDOWN_SECONDS:
            return
        track.notified[finding["type"]] = ts
        title, message = render_message(self.hass.config.language, self._meta.get(track.entity_id, {}), finding)
        if self._notify_persistent:
            persistent_notification.async_create(
                self.hass, message, title, self._notification_id(track.entity_id, finding["type"])
            )
        if self._notify_entity is not None and self.hass.services.has_service("notify", "send_message"):
            self.hass.async_create_task(self._async_send(title, message))

    async def _async_send(self, title: str, message: str) -> None:
        try:
            await self.hass.services.async_call(
                "notify", "send_message", {"title": title, "message": message},
                target={"entity_id": self._notify_entity}, blocking=True,
            )
        except HomeAssistantError as err:
            _LOGGER.warning("Notification via %s failed: %s", self._notify_entity, type(err).__name__)

    def _save(self) -> None:
        self._store.async_delay_save(self._data, SAVE_DELAY_SECONDS)

    def _data(self) -> dict[str, Any]:
        tracks = {}
        for entity_id, track in self._tracks.items():
            data = asdict(track)
            data.pop("entity_id")
            tracks[entity_id] = data
        return {"tracks": tracks, "recent": self._recent}

    def _status(self, track: Track) -> str:
        if track.kind is None:
            return "unsupported"
        if any(not finding.get("acknowledged") for finding in track.findings.values()):
            return "problem"
        if track.missing_since is not None:
            return "no_data"
        if track.findings:
            return "acknowledged"
        if track.kind == KIND_BASELINE and not self._ready(track):
            return "learning"
        if track.pending_since is not None or track.drop is not None:
            return "checking"
        return "ok"

    @callback
    def _publish(self, now: float, *, force: bool = False) -> None:
        monitors = []
        findings = []
        for entity_id in self.entity_ids:
            track = self._tracks[entity_id]
            meta = self._meta.get(entity_id, {})
            item: dict[str, Any] = {
                "entity_id": entity_id,
                "name": meta.get("name", entity_id),
                "area": meta.get("area"),
                "floor": meta.get("floor"),
                "labels": list(meta.get("labels", ())),
                "kind": track.kind,
                "device_class": track.device_class,
                "unit": track.unit,
                "status": self._status(track),
            }
            if track.kind == KIND_BASELINE and track.mean is not None:
                item["learning"] = round(min(1.0, track.samples / MIN_SAMPLES, track.observed / LEARN_SECONDS), 2)
                if self._ready(track):
                    scale = self._scale(track)
                    item["reference"] = _round(track.mean)
                    item["band_low"] = _round(track.mean - self.threshold * scale)
                    item["band_high"] = _round(track.mean + self.threshold * scale)
            if track.last_reset is not None:
                item["last_reset"] = _iso(track.last_reset)
            monitors.append(item)
            for finding in track.findings.values():
                findings.append(dict(finding, name=item["name"], area=item["area"]))
        findings.sort(key=lambda finding: (finding["acknowledged"], finding["since"]))
        signature = (
            tuple((item["entity_id"], item["status"]) for item in monitors),
            tuple((finding["id"], finding["acknowledged"]) for finding in findings),
            len(self._recent),
        )
        if not force and signature == self._signature and now - self._published_at < PUBLISH_INTERVAL_SECONDS:
            return
        self._signature = signature
        self._published_at = now
        self.snapshot = {
            "active": sum(1 for finding in findings if not finding["acknowledged"]),
            "findings": findings,
            "monitors": monitors,
            "recent": list(self._recent),
            "sensitivity": self.sensitivity,
        }
        for listener in list(self._listeners):
            listener()


MESSAGES = {
    "de": {
        FINDING_DEVIATION: (
            "Powermesh: {name} auffällig",
            "{name}{area}: {value} {unit} liegt {direction} des gelernten Bereichs "
            "{band_low} bis {band_high} {unit} (seit {since}). Bitte Gerät und Quelle prüfen.",
        ),
        FINDING_COUNTER_GLITCH: (
            "Powermesh: Zählersprung bei {name}",
            "{name}{area}: Zählerstand fiel kurzzeitig von {before} auf {low} {unit} und kehrte zurück "
            "(seit {since}). Die Energiestatistik kann dadurch eine Spitze enthalten.",
        ),
        FINDING_COUNTER_DECREASE: (
            "Powermesh: Zählerstand gesunken bei {name}",
            "{name}{area}: Zählerstand sank von {before} auf {after} {unit} und blieb niedriger "
            "(seit {since}). Zählerwechsel, Gerät oder Integration prüfen.",
        ),
        FINDING_NO_DATA: (
            "Powermesh: Keine Werte von {name}",
            "{name}{area}: Seit {since} liefert die Quelle keine gültigen Werte.",
        ),
    },
    "en": {
        FINDING_DEVIATION: (
            "Powermesh: {name} unusual",
            "{name}{area}: {value} {unit} is {direction} the learned range "
            "{band_low} to {band_high} {unit} (since {since}). Check the device and source.",
        ),
        FINDING_COUNTER_GLITCH: (
            "Powermesh: counter jump at {name}",
            "{name}{area}: the counter briefly dropped from {before} to {low} {unit} and returned "
            "(since {since}). Energy statistics may contain a spike.",
        ),
        FINDING_COUNTER_DECREASE: (
            "Powermesh: counter decreased at {name}",
            "{name}{area}: the counter decreased from {before} to {after} {unit} and stayed lower "
            "(since {since}). Check for a meter change, the device or the integration.",
        ),
        FINDING_NO_DATA: (
            "Powermesh: no values from {name}",
            "{name}{area}: no valid values since {since}.",
        ),
    },
}
DIRECTIONS = {"de": {"above": "oberhalb", "below": "unterhalb"}, "en": {"above": "above", "below": "below"}}


def render_message(language: str | None, meta: Mapping[str, Any], finding: Mapping[str, Any]) -> tuple[str, str]:
    """Render a short, local notification text for one finding."""
    lang = "de" if isinstance(language, str) and language.casefold().startswith("de") else "en"
    title, body = MESSAGES[lang][finding["type"]]
    since_key = "missing_since" if finding["type"] == FINDING_NO_DATA else "since"
    since = dt_util.parse_datetime(str(finding.get(since_key, finding["since"])))
    values: dict[str, Any] = {
        key: value for key, value in finding.items() if isinstance(value, (int, float, str))
    }
    values.update({
        "name": meta.get("name", finding["entity_id"]),
        "area": f" ({meta['area']})" if meta.get("area") else "",
        "unit": finding.get("unit") or "",
        "since": dt_util.as_local(since).strftime("%d.%m. %H:%M") if since else "",
        "direction": DIRECTIONS[lang].get(str(finding.get("direction")), ""),
    })

    class _Safe(dict):
        def __missing__(self, key: str) -> str:
            return ""

    return title.format_map(_Safe(values)), body.format_map(_Safe(values))
