"""Local anomaly monitoring prototype (synthetic states only, no network)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import area_registry as ar, entity_registry as er, issue_registry as ir, label_registry as lr
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_mock_service

from custom_components.powermesh_energy import const
from custom_components.powermesh_energy.const import (
    CONF_API_KEY,
    CONF_ENTITIES,
    CONF_MODE,
    CONF_MONITORS,
    CONF_NOTIFY_ENTITY,
    CONF_NOTIFY_PERSISTENT,
    CONF_SENSITIVITY,
    DOMAIN,
    MODE_MONITOR,
)
from custom_components.powermesh_energy.diagnostics import async_get_config_entry_diagnostics
from custom_components.powermesh_energy.monitor import AnomalyMonitor, classify, discover
from .conftest import ENERGY, GAS, POWER

WASHER = "sensor.washer_power"
METER = "sensor.grid_import"
API_KEY = "pme_" + "a" * 16 + "_" + "b" * 64
T0 = 1_780_000_000.0
NOTIFY = "custom_components.powermesh_energy.monitor.persistent_notification.async_create"


def monitor_entry(**options) -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN, title="Powermesh Auffälligkeiten", data={CONF_MODE: MODE_MONITOR},
        options={CONF_MONITORS: [WASHER, METER], CONF_SENSITIVITY: "medium", CONF_NOTIFY_PERSISTENT: True} | options,
        unique_id=f"{DOMAIN}_monitor",
    )


def learn(monitor: AnomalyMonitor, entity_id: str = WASHER, start: float = T0, count: int = 50) -> float:
    """Feed a stable synthetic pattern alternating around 100 W every 30 minutes."""
    ts = start
    for index in range(count):
        ts = start + index * 1800
        monitor.observe(entity_id, 95.0 if index % 2 else 105.0, ts, POWER)
    return ts


def test_classify_supported_kpis():
    assert classify(POWER) == ("baseline", "power")
    assert classify(ENERGY) == ("counter", "energy")
    assert classify({"device_class": "temperature", "unit_of_measurement": "°C", "state_class": "measurement"}) == ("baseline", "temperature")
    assert classify(GAS) is None
    assert classify({"device_class": "power", "unit_of_measurement": "W", "state_class": "total"}) is None
    assert classify({"device_class": "energy", "unit_of_measurement": "kWh", "state_class": "measurement"}) is None


async def test_discovery_uses_areas_labels_and_skips_disabled(hass):
    areas = ar.async_get(hass)
    labels = lr.async_get(hass)
    entities = er.async_get(hass)
    kitchen = areas.async_create("Küche")
    cellar = areas.async_create("Keller")
    critical = labels.async_create("Kritisch")
    washer = entities.async_get_or_create("sensor", "demo", "washer", suggested_object_id="washer_power")
    entities.async_update_entity(washer.entity_id, area_id=cellar.id, labels={critical.label_id})
    fridge = entities.async_get_or_create("sensor", "demo", "fridge", suggested_object_id="fridge_power")
    entities.async_update_entity(fridge.entity_id, area_id=kitchen.id)
    hidden = entities.async_get_or_create(
        "sensor", "demo", "hidden", suggested_object_id="hidden_power", disabled_by=er.RegistryEntryDisabler.USER
    )
    for entity_id in (washer.entity_id, fridge.entity_id, hidden.entity_id):
        hass.states.async_set(entity_id, "50", POWER)
    hass.states.async_set(METER, "1000", ENERGY)
    hass.states.async_set("sensor.gas", "5", GAS)

    found = {item.entity_id: item for item in discover(hass)}
    assert set(found) == {washer.entity_id, fridge.entity_id, METER}
    assert found[washer.entity_id].area == "Keller"
    assert found[washer.entity_id].labels == ("Kritisch",)
    assert found[METER].kind == "counter"
    assert [item.entity_id for item in discover(hass, [kitchen.id])] == [fridge.entity_id]
    assert [item.entity_id for item in discover(hass, (), [critical.label_id])] == [washer.entity_id]


async def test_learned_range_deviation_notification_and_acknowledge(hass):
    entry = monitor_entry(**{CONF_NOTIFY_ENTITY: "notify.phone"})
    entry.add_to_hass(hass)
    sent = async_mock_service(hass, "notify", "send_message")
    monitor = AnomalyMonitor(hass, entry)
    ts = learn(monitor)
    monitor.tick(ts)
    item = next(item for item in monitor.snapshot["monitors"] if item["entity_id"] == WASHER)
    assert item["status"] == "ok"
    assert item["band_low"] < 100 < item["band_high"]

    with patch(NOTIFY) as notify:
        monitor.observe(WASHER, 300.0, ts + 60, POWER)
        monitor.tick(ts + 300)
        assert monitor.snapshot["active"] == 0
        assert monitor.snapshot["monitors"][0]["status"] == "checking"
        monitor.tick(ts + 700)
        await hass.async_block_till_done()
    assert monitor.snapshot["active"] == 1
    finding = monitor.snapshot["findings"][0]
    assert finding["type"] == "deviation" and finding["direction"] == "above"
    assert finding["value"] == 300.0
    notify.assert_called_once()
    assert "sensor.washer_power" in notify.call_args.args[1]
    assert len(sent) == 1 and sent[0].data["entity_id"] in ("notify.phone", ["notify.phone"])

    # Learning is frozen while unacknowledged: the outlier does not widen the range.
    frozen = monitor._tracks[WASHER].mean
    monitor.observe(WASHER, 310.0, ts + 1800, POWER)
    assert monitor._tracks[WASHER].mean == frozen

    assert monitor.acknowledge("unknown") == 0
    assert monitor.acknowledge(finding["id"]) == 1
    assert monitor.snapshot["active"] == 0
    assert monitor.snapshot["findings"][0]["acknowledged"] is True
    monitor.observe(WASHER, 100.0, ts + 3600, POWER)
    monitor.tick(ts + 3600)
    assert monitor.snapshot["findings"] == []
    assert monitor.snapshot["recent"][0]["type"] == "deviation"


async def test_short_spike_is_not_reported(hass):
    entry = monitor_entry()
    entry.add_to_hass(hass)
    monitor = AnomalyMonitor(hass, entry)
    ts = learn(monitor)
    monitor.observe(WASHER, 300.0, ts + 60, POWER)
    monitor.observe(WASHER, 100.0, ts + 300, POWER)
    monitor.tick(ts + 1200)
    assert monitor.snapshot["active"] == 0
    assert monitor.snapshot["monitors"][0]["status"] == "ok"


async def test_learning_period_reports_nothing_and_unit_change_restarts(hass):
    entry = monitor_entry()
    entry.add_to_hass(hass)
    monitor = AnomalyMonitor(hass, entry)
    ts = learn(monitor, count=10)
    monitor.observe(WASHER, 5000.0, ts + 60, POWER)
    monitor.tick(ts + 7200)
    assert monitor.snapshot["active"] == 0
    assert monitor.snapshot["monitors"][0]["status"] == "learning"
    ts = learn(monitor, start=ts + 7200)
    assert monitor._tracks[WASHER].samples > 30
    monitor.observe(WASHER, 0.1, ts + 60, POWER | {"unit_of_measurement": "kW"})
    assert monitor._tracks[WASHER].samples == 0
    assert monitor._tracks[WASHER].unit == "kW"


async def test_counter_glitch_reset_and_decrease(hass):
    entry = monitor_entry()
    entry.add_to_hass(hass)
    with patch(NOTIFY):
        monitor = AnomalyMonitor(hass, entry)
        monitor.observe(METER, 1000.0, T0, ENERGY)
        monitor.observe(METER, 1001.0, T0 + 60, ENERGY)
        monitor.observe(METER, 0.4, T0 + 120, ENERGY)
        monitor.observe(METER, 1001.2, T0 + 180, ENERGY)
        assert [item["type"] for item in monitor._tracks[METER].findings.values()] == ["counter_glitch"]
        assert monitor.acknowledge() == 1
        assert monitor._tracks[METER].findings == {}

        monitor.observe(METER, 2.0, T0 + 600, ENERGY)
        monitor.observe(METER, 3.0, T0 + 900, ENERGY)
        monitor.tick(T0 + 600 + 1801)
        assert monitor._tracks[METER].findings == {}
        assert monitor._tracks[METER].last_reset == T0 + 600

        monitor.observe(METER, 2.5, T0 + 4000, ENERGY)
        monitor.tick(T0 + 4000 + 1801)
    finding = monitor._tracks[METER].findings["counter_decrease"]
    assert finding["before"] == 3.0 and finding["after"] == 2.5
    assert monitor.snapshot["active"] == 1


async def test_missing_values_raise_and_clear_no_data(hass):
    entry = monitor_entry(**{CONF_NOTIFY_PERSISTENT: False})
    entry.add_to_hass(hass)
    monitor = AnomalyMonitor(hass, entry)
    monitor.observe(WASHER, 100.0, T0, POWER)
    monitor.observe(WASHER, None, T0 + 60)
    monitor.tick(T0 + 1000)
    assert monitor.snapshot["active"] == 0
    monitor.tick(T0 + 60 + 1800)
    assert monitor.snapshot["findings"][0]["type"] == "no_data"
    monitor.observe(WASHER, 100.0, T0 + 4000, POWER)
    monitor.tick(T0 + 4000)
    assert monitor.snapshot["findings"] == []
    assert monitor.snapshot["recent"][0]["type"] == "no_data"


async def test_state_is_persisted_locally_and_restored(hass, hass_storage):
    entry = monitor_entry()
    entry.add_to_hass(hass)
    monitor = AnomalyMonitor(hass, entry)
    learn(monitor)
    monitor.observe(METER, 10.0, T0, ENERGY)
    monitor.observe(METER, None, T0 + 60)
    await monitor.async_stop()
    stored = hass_storage[f"{DOMAIN}.{entry.entry_id}.monitor"]
    assert stored["data"]["tracks"][WASHER]["samples"] == 49

    restored = AnomalyMonitor(hass, entry)
    await restored.async_start()
    assert restored._tracks[WASHER].mean == monitor._tracks[WASHER].mean
    assert restored._tracks[METER].missing_since is None
    await restored.async_stop()
    await restored.async_remove()
    assert f"{DOMAIN}.{entry.entry_id}.monitor" not in hass_storage


async def test_config_flow_entities_service_and_diagnostics(hass):
    hass.states.async_set(WASHER, "100", POWER | {"friendly_name": "Waschmaschine"})
    hass.states.async_set(METER, "1000", ENERGY)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.MENU
    assert result["menu_options"] == ["monitor", "local"]
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "monitor"})
    assert result["step_id"] == "monitor"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["step_id"] == "monitor_select"
    assert result["description_placeholders"]["count"] == "2"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_MONITORS: []})
    assert result["errors"] == {"base": "no_monitors"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_MONITORS: [WASHER, METER]})
    assert result["step_id"] == "monitor_settings"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_SENSITIVITY: "high", CONF_NOTIFY_PERSISTENT: False}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_MODE: MODE_MONITOR}
    assert result["options"][CONF_MONITORS] == [WASHER, METER]
    await hass.async_block_till_done()
    entry = result["result"]
    assert isinstance(entry.runtime_data, AnomalyMonitor)

    registry = er.async_get(hass)
    findings_id = registry.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_findings")
    problem_id = registry.async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_problem")
    assert hass.states.get(findings_id).state == "0"
    assert hass.states.get(problem_id).state == "off"
    monitors = hass.states.get(findings_id).attributes["monitors"]
    assert {item["entity_id"]: item["status"] for item in monitors} == {WASHER: "learning", METER: "ok"}
    assert monitors[0]["name"] == "Waschmaschine"

    response = await hass.services.async_call(DOMAIN, "acknowledge", {}, blocking=True, return_response=True)
    assert response == {"acknowledged": 0}

    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["mode"] == MODE_MONITOR and diagnostics["monitors"] == 2
    assert "sensor." not in json.dumps(diagnostics) and "Waschmaschine" not in json.dumps(diagnostics)

    second = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    second = await hass.config_entries.flow.async_configure(second["flow_id"], {"next_step_id": "monitor"})
    assert second == second | {"type": FlowResultType.ABORT, "reason": "already_configured"}

    options = await hass.config_entries.options.async_init(entry.entry_id)
    assert options["step_id"] == "monitor"
    options = await hass.config_entries.options.async_configure(options["flow_id"], {})
    options = await hass.config_entries.options.async_configure(options["flow_id"], {CONF_MONITORS: [WASHER]})
    options = await hass.config_entries.options.async_configure(
        options["flow_id"], {CONF_SENSITIVITY: "low", CONF_NOTIFY_PERSISTENT: True}
    )
    assert options["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert entry.runtime_data.entity_ids == [WASHER]
    assert entry.runtime_data.threshold == 6.0

    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()


async def test_sensor_selection_search_type_filter_and_bulk_affect_shown_only(hass):
    hass.states.async_set(WASHER, "100", POWER | {"friendly_name": "Waschmaschine"})
    hass.states.async_set("sensor.dryer_power", "50", POWER | {"friendly_name": "Trockner"})
    hass.states.async_set(METER, "1000", ENERGY | {"friendly_name": "Netzbezug"})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "monitor"})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    schema = result["data_schema"].schema
    types_key = next(key for key in schema if key == "types")
    assert schema[types_key].config["options"] == ["power", "energy"]
    values = lambda result: [option["value"] for option in next(  # noqa: E731
        value for key, value in result["data_schema"].schema.items() if key == CONF_MONITORS).config["options"]]
    assert values(result)[-1] == METER
    assert result["description_placeholders"]["selected"] == "3"

    flow_id = result["flow_id"]
    result = await hass.config_entries.flow.async_configure(
        flow_id, {CONF_MONITORS: [WASHER, "sensor.dryer_power", METER], "types": ["energy"], "bulk": "keep"})
    assert result["step_id"] == "monitor_select" and values(result) == [METER]
    result = await hass.config_entries.flow.async_configure(flow_id, {CONF_MONITORS: [METER], "types": ["energy"], "bulk": "none"})
    assert values(result) == [METER] and result["description_placeholders"]["selected"] == "2"

    result = await hass.config_entries.flow.async_configure(flow_id, {CONF_MONITORS: [], "types": [], "search": "trockner", "bulk": "keep"})
    assert values(result) == ["sensor.dryer_power"] and result["description_placeholders"]["shown"] == "1"
    result = await hass.config_entries.flow.async_configure(
        flow_id, {CONF_MONITORS: ["sensor.dryer_power"], "search": "trockner", "bulk": "none"})
    assert result["description_placeholders"]["selected"] == "1"
    result = await hass.config_entries.flow.async_configure(flow_id, {CONF_MONITORS: [], "search": "", "bulk": "all"})
    assert result["description_placeholders"]["selected"] == "3"
    result = await hass.config_entries.flow.async_configure(
        flow_id, {CONF_MONITORS: [WASHER, "sensor.dryer_power"], "search": "", "bulk": "keep"})
    assert result["step_id"] == "monitor_settings"
    result = await hass.config_entries.flow.async_configure(flow_id, {CONF_SENSITIVITY: "medium", CONF_NOTIFY_PERSISTENT: False})
    assert set(result["options"][CONF_MONITORS]) == {WASHER, "sensor.dryer_power"}


async def test_no_candidates_error(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "monitor"})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["errors"] == {"base": "no_candidates"}


async def test_existing_cloud_entry_is_kept_but_sends_nothing(hass):
    assert const.CLOUD_TRANSFER_ENABLED is False
    entry = MockConfigEntry(
        domain=DOMAIN, data={CONF_API_KEY: API_KEY}, options={CONF_ENTITIES: [METER]}, unique_id="a" * 16
    )
    entry.add_to_hass(hass)
    with patch("custom_components.powermesh_energy.PowermeshClient") as client, patch(
        "custom_components.powermesh_energy.PowermeshUploader"
    ) as uploader:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    client.assert_not_called()
    uploader.assert_not_called()
    assert entry.state is config_entries.ConfigEntryState.LOADED
    assert entry.runtime_data is None
    assert ir.async_get(hass).async_get_issue(DOMAIN, f"cloud_transfer_disabled_{entry.entry_id}")
    assert not er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)

    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert diagnostics["mode"] == "cloud_disabled"
    assert API_KEY not in json.dumps(diagnostics)

    options = await hass.config_entries.options.async_init(entry.entry_id)
    assert options == options | {"type": FlowResultType.ABORT, "reason": "cloud_transfer_disabled"}
    reauth = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_REAUTH, "entry_id": entry.entry_id}, data=dict(entry.data)
    )
    assert reauth == reauth | {"type": FlowResultType.ABORT, "reason": "cloud_transfer_disabled"}

    assert await hass.config_entries.async_unload(entry.entry_id)
    assert entry.data == {CONF_API_KEY: API_KEY}


def test_translations_cover_monitor_and_marketplace():
    root = Path(__file__).parents[1] / "custom_components" / DOMAIN
    for path in (root / "strings.json", root / "translations" / "en.json", root / "translations" / "de.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        for flow in ("config", "options"):
            for step in ("monitor", "monitor_select", "monitor_settings"):
                assert step in data[flow]["step"], (path, flow, step)
            assert "cloud_transfer_disabled" in data[flow]["abort"]
        assert "monitor" in data["config"]["step"]["user"]["menu_options"]
        assert set(data["selector"]["sensitivity"]["options"]) == {"low", "medium", "high"}
        assert "acknowledge" in data["services"]
        assert "cloud_transfer_disabled" in data["issues"]
        text = path.read_text(encoding="utf-8")
        assert text.count("HACS") == text.count("Marketplace")
