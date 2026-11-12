"""REST configuration and durable uploader behavior against Home Assistant."""

from copy import deepcopy
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from homeassistant import config_entries
from homeassistant.const import CONF_API_KEY
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.powermesh_energy.api import (
    PowermeshAuthError, PowermeshClient, PowermeshConnectionError,
    PowermeshRejectedError, UploadResult,
    encode_request,
)
from custom_components.powermesh_energy.const import (
    CONF_API_KEY as ENTRY_API_KEY,
    DOMAIN,
    CONF_ENTITIES,
    CONF_SMOOTHING,
    API_RELEASE,
    CONF_MODE,
    MODE_LOCAL,
    CONF_ROLES,
    CARD_URL,
    MODE_SNAPSHOT,
    CONF_STORAGE_MODE,
    CONF_PAIRING_LINKED,
    PAIRING_STORE,
    STORAGE_VERSION,
)
from custom_components.powermesh_energy.uploader import PowermeshUploader
from .conftest import ENERGY

# The retained powermesh.de transfer is disabled in the product; test it explicitly enabled.
pytestmark = pytest.mark.usefixtures("cloud_transfer")

API_KEY = "pme_" + "a" * 16 + "_" + "b" * 64
KEY_ID = "a" * 16
CONNECTION = {ENTRY_API_KEY: API_KEY}
STATUS = {
    "status": "ok", "api_version": 2, "api_release": API_RELEASE,
    "client": {"minimum": "0.1.0", "latest": "0.1.0"},
    "limits": {"max_readings_per_request": 200, "max_body_bytes": 131072, "requests_per_minute": 100, "buffer_limit_readings": 5000},
    "retention_days": 365, "scopes": ["readings:write"],
}


def reading(value=1):
    return {
        "entity_id": "sensor.grid_import",
        "timestamp": dt_util.utcnow().replace(microsecond=0).isoformat(),
        "state": value,
        "unit_of_measurement": "kWh",
        "attributes": {"device_class": "energy", "state_class": "total_increasing"},
        "smoothing": "none",
    }


async def start_key_flow(hass):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.MENU
    assert result["menu_options"] == ["monitor", "local", "api_key", "register_website", "register"]
    return await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "api_key"})


async def test_local_flow_validates_roles_without_network(hass):
    hass.states.async_set("sensor.solar", "450", {"unit_of_measurement": "W"})
    hass.states.async_set("sensor.battery", "60", {"unit_of_measurement": "%"})
    hass.states.async_set("sensor.energy", "10", ENERGY)
    with patch("custom_components.powermesh_energy.config_flow.PowermeshClient") as client:
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "local"})
        assert result["step_id"] == "local"
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
        assert result["errors"] == {"base": "no_entities"}
        from homeassistant.data_entry_flow import InvalidData
        from custom_components.powermesh_energy.config_flow import _local_errors
        with pytest.raises(InvalidData):
            await hass.config_entries.flow.async_configure(result["flow_id"], {"solar_power": "sensor.energy"})
        assert _local_errors(hass, {"solar_power": "sensor.energy"}) == {"solar_power": "invalid_source"}
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {"solar_power": "sensor.solar", "grid_import_power": "sensor.solar"})
        assert result["errors"] == {"grid_import_power": "duplicate_source"}
        with patch("custom_components.powermesh_energy.async_setup_entry", return_value=True):
            result = await hass.config_entries.flow.async_configure(result["flow_id"], {"solar_power": "sensor.solar", "battery_soc": "sensor.battery"})
        assert result["type"] is FlowResultType.CREATE_ENTRY
        assert result["data"] == {CONF_MODE: MODE_LOCAL}
        assert result["options"][CONF_ROLES] == {"solar_power": "sensor.solar", "battery_soc": "sensor.battery"}
        client.assert_not_called()


async def test_local_entry_setup_options_diagnostics_and_removal(hass):
    from custom_components.powermesh_energy import async_remove_entry, async_setup_entry, async_unload_entry
    from custom_components.powermesh_energy.diagnostics import async_get_config_entry_diagnostics
    from custom_components.powermesh_energy.sensor import PowermeshOverviewSensor

    hass.states.async_set("sensor.solar", "500", {"unit_of_measurement": "W"})
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_MODE: MODE_LOCAL}, options={CONF_ROLES: {"solar_power": "sensor.solar"}})
    entry.add_to_hass(hass)
    resources = AsyncMock()
    with patch("custom_components.powermesh_energy.PowermeshClient") as client, patch.object(
        hass.config_entries, "async_forward_entry_setups", AsyncMock()
    ), patch.object(hass, "http", MagicMock(async_register_static_paths=resources)), patch(
        "custom_components.powermesh_energy.add_extra_js_url"
    ) as extra_js:
        hass.config.components.add("frontend")
        assert await async_setup_entry(hass, entry)
        assert entry.runtime_data is None
        client.assert_not_called()
        assert resources.call_args.args[0][0].url_path == CARD_URL
        extra_js.assert_called_once_with(hass, f"{CARD_URL}?v=0.9.1")
        await async_setup_entry(hass, entry)
        assert resources.call_count == 1
        assert extra_js.call_count == 1
    sensor = PowermeshOverviewSensor(entry)
    assert sensor.extra_state_attributes == {CONF_ROLES: {"solar_power": "sensor.solar"}}
    assert await async_get_config_entry_diagnostics(hass, entry) == {"mode": "local", "integration_version": "0.9.1"}
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["step_id"] == "local"
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"grid_import_power": "sensor.solar"})
    assert result["data"] == {CONF_ROLES: {"grid_import_power": "sensor.solar"}}
    with patch("homeassistant.helpers.storage.Store") as store:
        await async_remove_entry(hass, entry)
        store.assert_not_called()
    with patch.object(hass.config_entries, "async_unload_platforms", AsyncMock(return_value=True)):
        assert await async_unload_entry(hass, entry)


async def test_pairing_installation_secret_is_removed_only_after_entry_setup(hass):
    from custom_components.powermesh_energy import async_setup_entry

    entry = MockConfigEntry(domain=DOMAIN, data={
        ENTRY_API_KEY: API_KEY, CONF_STORAGE_MODE: MODE_SNAPSHOT, CONF_PAIRING_LINKED: True,
    })
    entry.add_to_hass(hass)
    store = Store(hass, STORAGE_VERSION, PAIRING_STORE, private=True)
    await store.async_save({"installation_secret": "c" * 64})
    with patch("custom_components.powermesh_energy.PowermeshUploader.async_start", AsyncMock()), patch.object(
        hass.config_entries, "async_forward_entry_setups", AsyncMock()
    ):
        assert await async_setup_entry(hass, entry)
    assert await store.async_load() is None
    assert entry.data[ENTRY_API_KEY] == API_KEY
    assert CONF_PAIRING_LINKED not in entry.data


async def test_local_card_resource_is_served_by_home_assistant(hass, hass_client):
    from homeassistant.setup import async_setup_component
    assert await async_setup_component(hass, "http", {"http": {}})
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_MODE: MODE_LOCAL}, options={CONF_ROLES: {"solar_power": "sensor.solar"}})
    entry.add_to_hass(hass)
    with patch("custom_components.powermesh_energy.PowermeshClient") as transport:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        client = await hass_client()
        response = await client.get(CARD_URL)
        assert response.status == 200
        assert 'customElements.define("powermesh-energy-card"' in await response.text()
        transport.assert_not_called()
        assert entry.runtime_data is None
        assert await hass.config_entries.async_reload(entry.entry_id)


def make_uploader(hass):
    entry = MockConfigEntry(domain=DOMAIN, data=CONNECTION, options={
        CONF_ENTITIES: ["sensor.grid_import"], CONF_SMOOTHING: {"sensor.grid_import": "none"},
    })
    entry.add_to_hass(hass)
    client = AsyncMock(spec=PowermeshClient)
    client.key_id = KEY_ID
    client.base_url = "https://api.powermesh.de"
    client.status.return_value = deepcopy(STATUS)
    client.upload.return_value = UploadResult(1, 0)
    uploader = PowermeshUploader(hass, entry, client)
    entry.runtime_data = uploader
    uploader._store = AsyncMock()
    uploader._store.async_delay_save = MagicMock()
    uploader._buffer_owner = client.key_id
    uploader.buffer_limit = 5000
    return uploader, client, entry


async def test_snapshot_uploader_coalesces_state_changes_and_uses_snapshot_endpoint(hass):
    uploader, client, _entry = make_uploader(hass)
    uploader.snapshot_mode = True
    first = reading(1)
    second = reading(2)
    second["timestamp"] = (dt_util.utcnow() + timedelta(seconds=1)).isoformat()
    uploader._append(first)
    uploader._append(second)
    assert len(uploader._buffer) == 1
    assert uploader._buffer[0]["state"] == 2
    client.snapshot.return_value = UploadResult(1, 0)
    await uploader._upload_batches()
    client.snapshot.assert_awaited_once_with([second])
    client.upload.assert_not_awaited()
    assert uploader.pending == 0


async def test_snapshot_uploader_preserves_sensor_measurement_time(hass):
    uploader, _client, _entry = make_uploader(hass)
    uploader.snapshot_mode = True
    measured_at = (dt_util.utcnow() - timedelta(hours=1)).replace(microsecond=0)
    uploader._record("sensor.grid_import", "10", ENERGY, measured_at)
    assert dt_util.parse_datetime(uploader._buffer[0]["timestamp"]) == measured_at


async def test_config_flow_and_smoothing(hass):
    hass.states.async_set("sensor.grid_import", "10", ENERGY)
    with patch("custom_components.powermesh_energy.config_flow.PowermeshClient") as client:
        client.return_value.status = AsyncMock(return_value=STATUS)
        result = await start_key_flow(hass)
        assert result["type"] is FlowResultType.FORM
        assert CONF_API_KEY in result["data_schema"].schema
        result = await hass.config_entries.flow.async_configure(result["flow_id"], CONNECTION)
        assert result["step_id"] == "entities"
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_ENTITIES: ["sensor.grid_import"]})
        assert result["step_id"] == "smoothing"
        with patch("custom_components.powermesh_energy.async_setup_entry", return_value=True):
            result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
        assert result["type"] is FlowResultType.CREATE_ENTRY
        assert result["data"] == CONNECTION | {CONF_STORAGE_MODE: MODE_SNAPSHOT}
        assert result["options"][CONF_SMOOTHING] == {"sensor.grid_import": "none"}


async def test_options_flow_corrects_existing_smoothing_for_energy_sensors(hass):
    hass.states.async_set("sensor.grid_import", "10", ENERGY)
    hass.states.async_set(
        "sensor.power_now",
        "450",
        {"device_class": "power", "unit_of_measurement": "W", "state_class": "measurement"},
    )
    entry = MockConfigEntry(
        domain=DOMAIN,
        data=CONNECTION,
        options={
            CONF_ENTITIES: ["sensor.grid_import", "sensor.power_now"],
            CONF_SMOOTHING: {"sensor.grid_import": "mean_5min", "sensor.power_now": "throttle_1min"},
        },
    )
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["step_id"] == "init"
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {CONF_ENTITIES: ["sensor.grid_import", "sensor.power_now"]},
    )
    assert result["step_id"] == "smoothing"
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {"sensor.grid_import": "none", "sensor.power_now": "throttle_1min"},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_SMOOTHING] == {
        "sensor.grid_import": "none",
        "sensor.power_now": "throttle_1min",
    }


async def test_config_flow_allows_numeric_temperature_sensor(hass):
    hass.states.async_set(
        "sensor.room_temperature",
        "21.5",
        {
            "device_class": "temperature",
            "unit_of_measurement": "°C",
            "state_class": "measurement",
        },
    )
    with patch("custom_components.powermesh_energy.config_flow.PowermeshClient") as client:
        client.return_value.status = AsyncMock(return_value=STATUS)
        result = await start_key_flow(hass)
        result = await hass.config_entries.flow.async_configure(result["flow_id"], CONNECTION)
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_ENTITIES: ["sensor.room_temperature"]}
        )
        assert result["step_id"] == "smoothing"
        assert "sensor.room_temperature" in result["data_schema"].schema


@pytest.mark.parametrize("error,expected", [
    (PowermeshAuthError("access_revoked"), "invalid_auth"),
    (PowermeshConnectionError("cannot_connect"), "cannot_connect"),
])
async def test_config_errors(hass, error, expected):
    with patch("custom_components.powermesh_energy.config_flow.PowermeshClient") as client:
        client.return_value.status = AsyncMock(side_effect=error)
        result = await start_key_flow(hass)
        result = await hass.config_entries.flow.async_configure(result["flow_id"], CONNECTION)
        assert result["errors"] == {"base": expected}


async def test_batch_saved_before_publish_and_timeout_retry_is_identical(hass):
    uploader, client, _ = make_uploader(hass)
    uploader._append(reading())
    sent = []

    async def upload(readings):
        assert uploader._store.async_save.call_args.args[0]["inflight"]["readings"] == readings
        sent.append(deepcopy(readings))
        if len(sent) == 1:
            raise PowermeshConnectionError("timeout")
        return UploadResult(1, 0)

    client.upload.side_effect = upload
    await uploader.async_upload()
    assert uploader.pending == 1
    assert uploader._inflight is not None
    uploader._retry_at = dt_util.utcnow() - timedelta(seconds=1)
    await uploader.async_upload()
    assert sent[0] == sent[1]
    assert uploader.pending == 0
    assert uploader.accepted_total == 1
    assert uploader._store.async_save.call_args.args[0]["inflight"] is None


async def test_restart_reuses_persisted_batch(hass):
    uploader, client, _ = make_uploader(hass)
    uploader._append(reading())
    client.upload.side_effect = PowermeshConnectionError("timeout")
    await uploader.async_upload()
    saved = uploader._data()
    replacement, replacement_client, _ = make_uploader(hass)
    replacement._store.async_load.return_value = saved
    await replacement.async_start()
    await hass.async_block_till_done()
    assert replacement_client.upload.call_args.args[0] == saved["inflight"]["readings"]
    assert replacement.pending == 0
    await replacement.async_stop()


async def test_new_reading_during_publish_is_not_removed(hass):
    uploader, client, _ = make_uploader(hass)
    uploader._append(reading(1))
    sent = []

    async def upload(readings):
        sent.append(deepcopy(readings))
        if len(sent) == 1:
            uploader._append(reading(2))
        return UploadResult(1, 0)

    client.upload.side_effect = upload
    await uploader.async_upload()
    assert [batch[0]["state"] for batch in sent] == [1, 2]
    assert uploader.pending == 0


async def test_changed_credential_never_rebinds_buffer(hass):
    uploader, client, entry = make_uploader(hass)
    uploader._append(reading())
    client.key_id = "c" * 16
    await uploader.async_upload()
    client.upload.assert_not_awaited()
    assert uploader.pending == 1 and uploader._paused
    assert uploader.last_error == "buffer_owner_changed"
    assert ir.async_get(hass).async_get_issue(DOMAIN, f"buffer_owner_changed_{entry.entry_id}")


async def test_permanent_rejection_keeps_batch_and_stops(hass):
    uploader, client, _ = make_uploader(hass)
    uploader._append(reading())
    client.upload.side_effect = PowermeshRejectedError(
        "invalid_readings", 422, {"error": {"code": "invalid_readings"}}
    )
    await uploader.async_upload()
    assert uploader.pending == 1 and uploader._paused
    assert uploader.dropped_total == 0
    assert uploader._inflight is not None


async def test_offline_buffer_drops_only_oldest_when_full(hass):
    uploader, _, _ = make_uploader(hass)
    uploader.buffer_limit = 3
    for index in range(4):
        item = reading(index)
        item["entity_id"] = f"sensor.item_{index}"
        uploader._append(item)
    assert uploader.pending == 3
    assert uploader.dropped_total == 1
    assert uploader._buffer[0]["entity_id"] == "sensor.item_0"
    assert uploader._buffer[-1]["entity_id"] == "sensor.item_2"
    assert uploader.status == "buffer_full"


async def test_revoked_client_reauth_keeps_data(hass):
    uploader, client, entry = make_uploader(hass)
    uploader._append(reading())
    client.upload.side_effect = PowermeshAuthError("access_revoked")
    with patch.object(entry, "async_start_reauth") as reauth:
        await uploader.async_upload()
    reauth.assert_called_once()
    assert uploader.pending == 1 and uploader._paused


async def test_legacy_incompatible_buffer_is_preserved_but_not_sent(hass):
    uploader, client, _ = make_uploader(hass)
    legacy_reading = {
        "entity_id": "sensor.grid_import",
        "timestamp": "2026-01-01T00:00:00Z",
        "value": 1,
        "unit": "kWh",
        "device_class": "energy",
        "state_class": "total_increasing",
    }
    stored = {"readings": [legacy_reading], "generation": "c" * 32, "owner": KEY_ID}
    uploader._store.async_load.return_value = stored
    await uploader.async_start()
    assert uploader._paused and uploader.pending == 1
    client.upload.assert_not_awaited()
    await uploader.async_stop()
    assert uploader._store.async_save.await_count == 0
    assert uploader._legacy_buffer == stored


async def test_setup_and_unload_without_network(hass):
    with patch("custom_components.powermesh_energy.PowermeshClient") as client:
        client.return_value = AsyncMock(spec=PowermeshClient)
        client.return_value.key_id = KEY_ID
        client.return_value.status.return_value = STATUS
        entry = MockConfigEntry(domain=DOMAIN, data=CONNECTION, options={CONF_ENTITIES: []})
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        assert await hass.config_entries.async_unload(entry.entry_id)


async def test_reauth_updates_credentials_without_removing_buffer(hass):
    entry = MockConfigEntry(domain=DOMAIN, data=CONNECTION, unique_id=KEY_ID)
    entry.add_to_hass(hass)
    with patch("custom_components.powermesh_energy.config_flow.PowermeshClient") as client:
        client.return_value.status = AsyncMock(return_value=STATUS)
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_REAUTH, "entry_id": entry.entry_id},
            data=CONNECTION,
        )
        assert result["step_id"] == "reauth_confirm"
        replacement_key = "pme_" + "f" * 16 + "_" + "e" * 64
        replacement = {ENTRY_API_KEY: replacement_key}
        with patch.object(hass.config_entries, "async_reload", return_value=True):
            result = await hass.config_entries.flow.async_configure(result["flow_id"], replacement)
        assert result["type"] is FlowResultType.ABORT
        assert result["reason"] == "reauth_successful"
        assert entry.data == replacement | {CONF_STORAGE_MODE: "readings"}


async def test_diagnostics_redact_all_credentials_and_no_values(hass):
    from custom_components.powermesh_energy.diagnostics import async_get_config_entry_diagnostics

    uploader, _, entry = make_uploader(hass)
    uploader._append(reading(987654.321))
    data = await async_get_config_entry_diagnostics(hass, entry)
    assert data["entry"][ENTRY_API_KEY] == "**REDACTED**"
    assert "987654.321" not in str(data)


async def test_save_failure_prevents_publish(hass):
    uploader, client, _ = make_uploader(hass)
    uploader._append(reading())
    uploader._store.async_save.side_effect = OSError("synthetic disk failure")
    with pytest.raises(OSError, match="synthetic disk failure"):
        await uploader.async_upload()
    client.upload.assert_not_awaited()
    assert uploader.pending == 1


async def test_stop_cancels_active_upload_and_persists_same_batch(hass):
    import asyncio

    uploader, client, _ = make_uploader(hass)
    uploader._append(reading())
    entered = asyncio.Event()

    async def waiting(request):
        entered.set()
        await asyncio.Event().wait()

    client.upload.side_effect = waiting
    task = asyncio.create_task(uploader.async_upload())
    await entered.wait()
    batch = deepcopy(uploader._inflight)
    await uploader.async_stop()
    assert task.cancelled()
    assert uploader._store.async_save.call_args.args[0]["inflight"] == batch
    assert uploader.pending == 1


async def test_overflow_error_is_logged_persisted_and_cleared_after_upload(hass, caplog):
    uploader, client, entry = make_uploader(hass)
    uploader.buffer_limit = 1
    client.status.return_value["limits"]["buffer_limit_readings"] = 1
    first = reading(1)
    uploader._append(first)
    extra = reading(2) | {"entity_id": "sensor.extra"}
    uploader._enqueue([extra])
    assert uploader._buffer == [first]
    assert uploader.status == "buffer_full"
    assert "Discarded new reading" in caplog.text
    assert "sensor.extra" not in caplog.text
    assert uploader._data()["dropped_total"] == 1
    assert uploader._data()["buffer_error"] == "buffer_full"
    issue_id = f"buffer_limit_{entry.entry_id}"
    assert ir.async_get(hass).async_get_issue(DOMAIN, issue_id).severity is ir.IssueSeverity.ERROR
    client.upload.side_effect = PowermeshConnectionError("timeout")
    await uploader.async_upload()
    assert uploader.status == "buffer_full"
    client.upload.side_effect = None
    uploader._retry_at = None
    await uploader.async_upload()
    assert uploader.status == "ok" and uploader.pending == 0
    assert uploader.dropped_total == 1
    assert ir.async_get(hass).async_get_issue(DOMAIN, issue_id) is None


async def test_full_buffer_counts_inflight_and_does_not_replace_oldest(hass):
    uploader, client, _ = make_uploader(hass)
    uploader.buffer_limit = 1
    client.status.return_value["limits"]["buffer_limit_readings"] = 1
    original = reading()
    uploader._append(original)

    async def upload(batch):
        assert uploader.pending == 1 and uploader._buffer == []
        uploader._append(reading(99))
        assert uploader.pending == 1
        assert uploader._inflight["readings"] == [original]
        return UploadResult(1, 0)

    client.upload.side_effect = upload
    await uploader.async_upload()
    assert uploader.pending == 0 and uploader.dropped_total == 1


async def test_unknown_limit_discards_without_sampling_and_recovers(hass, caplog):
    uploader, client, _ = make_uploader(hass)
    uploader.buffer_limit = None
    uploader._record("sensor.grid_import", "12", ENERGY, dt_util.utcnow())
    assert uploader.pending == 0 and uploader.dropped_total == 1
    assert uploader.status == "limits_unknown"
    assert "Discarded new reading" in caplog.text
    client.status.side_effect = PowermeshConnectionError("offline")
    await uploader.async_upload()
    assert uploader.status == "limits_unknown"
    client.status.side_effect = None
    hass.states.async_set("sensor.grid_import", "13", ENERGY)
    await uploader.async_upload()
    assert uploader.buffer_limit == 5000
    assert uploader.status == "ok" and uploader.pending == 0
    assert uploader.accepted_total == 1


async def test_restart_offline_reuses_only_same_owner_limit(hass):
    uploader, _, _ = make_uploader(hass)
    uploader.buffer_limit = 2
    uploader._append(reading())
    stored = uploader._data()
    replacement, client, _ = make_uploader(hass)
    replacement.buffer_limit = None
    replacement._store.async_load.return_value = stored
    client.status.side_effect = PowermeshConnectionError("offline")
    await replacement.async_start()
    await hass.async_block_till_done()
    assert replacement.buffer_limit == 2 and replacement.pending == 1
    replacement._enqueue([reading(2) | {"entity_id": "sensor.second"}])
    replacement._enqueue([reading(3) | {"entity_id": "sensor.third"}])
    assert replacement.pending == 2 and replacement.dropped_total == 1
    await replacement.async_stop()
    other, other_client, _ = make_uploader(hass)
    other.buffer_limit = None
    other_client.key_id = "f" * 16
    other_client.status.side_effect = PowermeshConnectionError("offline")
    other._store.async_load.return_value = stored
    await other.async_start()
    await hass.async_block_till_done()
    assert other.buffer_limit is None and other.pending == 1
    other._enqueue([reading(4) | {"entity_id": "sensor.fourth"}])
    assert other.pending == 1 and other.dropped_total == 1
    await other.async_stop()


async def test_limit_reduction_preserves_existing_readings(hass):
    uploader, client, _ = make_uploader(hass)
    for index in range(4):
        uploader._append(reading(index) | {"entity_id": f"sensor.item_{index}"})
    before = deepcopy(uploader._buffer)
    client.status.return_value["limits"]["buffer_limit_readings"] = 2
    assert await uploader.async_check_version()
    assert uploader.buffer_limit == 2 and uploader._buffer == before
    uploader._append(reading(5) | {"entity_id": "sensor.extra"})
    assert uploader._buffer == before and uploader.dropped_total == 1


async def test_restart_preserves_over_limit_buffer_and_loss_error(hass):
    uploader, _, _ = make_uploader(hass)
    for index in range(3):
        uploader._append(reading(index) | {"timestamp": (dt_util.utcnow() + timedelta(seconds=index)).isoformat()})
    uploader.buffer_limit = 1
    uploader._enqueue([reading(99) | {"entity_id": "sensor.extra"}])
    stored = uploader._data()
    replacement, client, entry = make_uploader(hass)
    replacement._store.async_load.return_value = stored
    client.status.side_effect = PowermeshConnectionError("offline")
    await replacement.async_start()
    await hass.async_block_till_done()
    assert replacement._buffer == stored["readings"]
    assert replacement.pending == 3 and replacement.buffer_limit == 1
    assert replacement.status == "buffer_full" and replacement.dropped_total == 1
    assert ir.async_get(hass).async_get_issue(DOMAIN, f"buffer_limit_{entry.entry_id}")
    await replacement.async_stop()


async def test_first_start_offline_never_uses_local_buffer_default(hass, caplog):
    uploader, client, _ = make_uploader(hass)
    uploader.buffer_limit = None
    uploader._buffer_owner = None
    uploader._store.async_load.return_value = None
    client.status.side_effect = PowermeshConnectionError("offline")
    hass.states.async_set("sensor.grid_import", "12", ENERGY)
    await uploader.async_start()
    await hass.async_block_till_done()
    assert uploader.pending == 0 and uploader.buffer_limit is None
    assert uploader.status == "limits_unknown" and uploader.dropped_total > 0
    assert "Discarded new reading" in caplog.text
    client.upload.assert_not_awaited()
    await uploader.async_stop()


@pytest.mark.parametrize("large_metadata,count", [(False, 451), (True, 80)])
async def test_backlog_split_obeys_reading_and_encoded_body_limits(hass, large_metadata, count):
    uploader, client, _ = make_uploader(hass)
    for index in range(count):
        item = reading(index) | {"entity_id": f"sensor.item_{index}"}
        if large_metadata:
            item["context"] = {"labels": [f"{i}:" + "x" * 250 for i in range(20)]}
        uploader._append(item)
    batches = []

    async def upload(batch):
        assert 1 <= len(batch) <= 200
        assert len(encode_request({"readings": batch})) <= 131072
        batches.append(deepcopy(batch))
        return UploadResult(len(batch), 0)

    client.upload.side_effect = upload
    await uploader.async_upload()
    assert uploader.pending == 0 and uploader.accepted_total == count
    assert sum(map(len, batches)) == count
    assert len(batches) > 1
    if not large_metadata:
        assert list(map(len, batches)) == [200, 200, 51]


async def test_backlog_stops_when_server_request_budget_is_exhausted(hass):
    uploader, client, _ = make_uploader(hass)
    for index in range(201):
        uploader._append(reading(index) | {"entity_id": f"sensor.item_{index}"})
    client.upload.return_value = UploadResult(200, 0, remaining_requests=0)
    await uploader.async_upload()
    assert client.upload.await_count == 1
    assert uploader.pending == 1 and uploader.accepted_total == 200
