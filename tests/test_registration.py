"""Invitation-bound account registration and account setup notices (synthetic only)."""

import asyncio
import json
import logging
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import aiohttp
import pytest
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import issue_registry as ir
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.powermesh_energy.api import (
    AccountState,
    PowermeshAuthError,
    PowermeshClient,
    PowermeshConnectionError,
    PowermeshRegistrationError,
    Pairing,
    Registration,
    UploadResult,
    claim_pairing,
    parse_account,
    register_account,
    start_pairing,
)
from custom_components.powermesh_energy.config_flow import REGISTRATION_ERRORS

# The retained powermesh.de transfer is disabled in the product; test it explicitly enabled.
pytestmark = pytest.mark.usefixtures("cloud_transfer")
from custom_components.powermesh_energy.const import (
    API_RELEASE,
    CLIENT_ID,
    CONF_ACCOUNT_STATUS_UNKNOWN,
    CONF_API_KEY,
    CONF_PAIRING_LINKED,
    CONF_ENTITIES,
    CONF_SETUP_EXPIRES_AT,
    CONF_SMOOTHING,
    CONF_STORAGE_MODE,
    DOMAIN,
    MIN_API_RELEASE,
    MODE_READINGS,
    MODE_SNAPSHOT,
    REST_BUFFER_FORMAT,
    REGISTRATION_CONSENT_VERSION,
)
from custom_components.powermesh_energy.uploader import PowermeshUploader
from .conftest import ENERGY
from .test_api_client import FakeResponse, FakeSession, status_body
from .test_integration import reading

API_KEY = "pme_" + "a" * 16 + "_" + "b" * 64
KEY_ID = "a" * 16
EMAIL = "synthetic.user@example.invalid"
PASSWORD = "Synthetic-Passw0rd-never-real"
INVITATION = "synthetic-invitation-code-0001"
WARNING = "Konto bis zur Frist auf powermesh.de einrichten, sonst werden Konto und alle Daten gelöscht."
COMPONENT = Path(__file__).parents[1] / "custom_components" / "powermesh_energy"


def future(seconds=3600):
    return int(dt_util.utcnow().timestamp()) + seconds


def registered_body(expires=None, **overrides):
    body = {
        "status": "ok",
        "api_version": 2,
        "api_release": API_RELEASE,
        "api_key": API_KEY,
        "account": {
            "setup_required": True,
            "setup_expires_at": expires or future(),
            "warning": WARNING,
        },
    }
    return body | overrides


class RaisingResponse:
    def __init__(self, error):
        self.error = error

    async def __aenter__(self):
        raise self.error

    async def __aexit__(self, *_args):
        return False


async def register(session):
    return await register_account(
        session, email=EMAIL, password=PASSWORD, invitation_code=INVITATION
    )


def test_registration_targets_new_api_release():
    assert API_RELEASE == MIN_API_RELEASE == "0.4.1"
    assert CLIENT_ID == "homeassistant/0.9.5"


async def test_register_sends_exact_fields_once_to_fixed_service_without_auth():
    expires = future()
    session = FakeSession(FakeResponse(status=201, body=registered_body(expires)))
    result = await register(session)
    assert len(session.calls) == 1
    args, kwargs = session.calls[0]
    assert args == ("POST", "https://api.powermesh.de/api/v2/register")
    assert kwargs["allow_redirects"] is False
    assert "Authorization" not in kwargs["headers"]
    assert kwargs["headers"]["X-Powermesh-Client"] == CLIENT_ID
    assert json.loads(kwargs["data"]) == {
        "email": EMAIL,
        "password": PASSWORD,
        "invitation_code": INVITATION,
        "consent_version": REGISTRATION_CONSENT_VERSION,
        "consent_privacy": True,
        "consent_terms": True,
        "energy_consent_version": "2026-11-13-rest-metadata-0.1.1",
        "energy_consent": True,
    }
    assert result.api_key == API_KEY
    assert result.account == AccountState(True, expires, WARNING)
    assert "b" * 64 not in repr(result)


async def test_pairing_start_and_claim_use_local_secret_and_wait_for_website_mfa():
    secret = "c" * 64
    code = "AbCdEf0123456789_-AbCd"
    expiry = future(1800)
    session = FakeSession(FakeResponse(status=201, body={
        "status": "ok", "api_release": API_RELEASE,
        "pairing_code": code, "expires_at": expiry,
    }))
    pairing = await start_pairing(session, secret)
    assert (pairing.code, pairing.expires_at) == (code, expiry)
    args, kwargs = session.calls[0]
    assert args == ("POST", "https://api.powermesh.de/api/v2/register")
    assert json.loads(kwargs["data"]) == {"action": "start", "installation_secret": secret}
    assert "Authorization" not in kwargs["headers"]
    assert "installation_secret" not in repr(pairing)

    pending = FakeSession(FakeResponse(body={"status": "pending", "api_release": API_RELEASE}))
    assert await claim_pairing(pending, secret) is None
    claimed = FakeSession(FakeResponse(body={
        "status": "ok", "api_release": API_RELEASE, "api_key": API_KEY,
        "account": {"setup_required": False, "setup_expires_at": None, "warning": None},
    }))
    result = await claim_pairing(claimed, secret)
    assert result == Registration(API_KEY, AccountState(False))
    assert json.loads(claimed.calls[0][1]["data"]) == {"action": "claim", "installation_secret": secret}


async def test_pairing_rejects_wrong_release_and_surfaces_operator_gate():
    secret = "d" * 64
    outdated = FakeSession(FakeResponse(body={
        "status": "ok", "api_release": "0.3.0", "pairing_code": "A" * 22, "expires_at": future(),
    }))
    outdated.response.headers["X-Powermesh-Api-Version"] = "0.3.0"
    with pytest.raises(PowermeshRegistrationError) as caught:
        await start_pairing(outdated, secret)
    assert caught.value.code == "update_required"
    closed = FakeSession(FakeResponse(status=403, body={"error": {"code": "registration_unavailable"}}))
    with pytest.raises(PowermeshRegistrationError) as caught:
        await start_pairing(closed, secret)
    assert caught.value.code == "registration_unavailable"


async def test_register_keeps_issued_key_when_account_block_is_malformed():
    body = registered_body() | {"account": {"setup_required": "yes"}}
    result = await register(FakeSession(FakeResponse(status=201, body=body)))
    assert result.api_key == API_KEY
    assert result.account is None


@pytest.mark.parametrize(
    ("status", "body", "code", "uncertain"),
    [
        (422, {"error": {"code": "invalid_registration"}}, "invalid_registration", False),
        (403, {"error": {"code": "invitation_invalid"}}, "invitation_invalid", False),
        (409, {"error": {"code": "account_exists"}}, "account_exists", False),
        (429, {"error": {"code": "registration_rate_limited"}}, "registration_rate_limited", False),
        (426, {"error": {"code": "client_outdated"}}, "update_required", False),
        (404, {"error": {"code": "not_found"}}, "registration_unavailable", False),
        (403, {"error": {"code": "forbidden"}}, "registration_rejected", False),
        (400, None, "registration_rejected", False),
        (500, {"error": {"code": "server_error"}}, "registration_uncertain", True),
        (503, None, "registration_uncertain", True),
        (201, {"status": "ok"}, "registration_uncertain", True),
        (201, {"api_key": "pme_invalid"}, "registration_uncertain", True),
        (200, registered_body(), "registration_uncertain", True),
    ],
)
async def test_register_error_mapping_never_echoes_input(status, body, code, uncertain):
    session = FakeSession(FakeResponse(status=status, body=body))
    with pytest.raises(PowermeshRegistrationError) as caught:
        await register(session)
    assert caught.value.code == code
    assert caught.value.uncertain is uncertain
    assert len(session.calls) == 1
    text = repr(caught.value) + str(caught.value.args)
    for secret in (EMAIL, PASSWORD, INVITATION):
        assert secret not in text


@pytest.mark.parametrize(
    ("error", "code", "uncertain"),
    [
        (aiohttp.ServerDisconnectedError(), "registration_uncertain", True),
        (asyncio.TimeoutError(), "registration_uncertain", True),
        (
            aiohttp.ClientConnectorError(MagicMock(), OSError(61, "synthetic refused")),
            "cannot_connect",
            False,
        ),
    ],
)
async def test_register_transport_failures(error, code, uncertain):
    session = FakeSession(RaisingResponse(error))
    with pytest.raises(PowermeshRegistrationError) as caught:
        await register(session)
    assert (caught.value.code, caught.value.uncertain) == (code, uncertain)
    assert caught.value.__cause__ is None
    assert len(session.calls) == 1


def test_parse_account_states_and_warning_sanitizing():
    assert parse_account({}) is None
    assert parse_account({"account": None}) is None
    assert parse_account({"account": {"setup_required": True, "setup_expires_at": "1"}}) is None
    done = {"setup_required": False, "setup_expires_at": None, "warning": None}
    assert parse_account({"account": done}) == AccountState(False)
    state = parse_account({"account": {
        "setup_required": True, "setup_expires_at": 1_900_000_000, "warning": " Frist\n\tbeachten ",
    }})
    assert state == AccountState(True, 1_900_000_000, "Frist beachten")
    for unsafe in (f"Konto {EMAIL}", f"Schlüssel {API_KEY}", 42):
        assert parse_account({"account": {
            "setup_required": True, "setup_expires_at": 1, "warning": unsafe,
        }}).warning is None
    long_state = parse_account({"account": {
        "setup_required": True, "setup_expires_at": 1, "warning": "x" * 2000,
    }})
    assert len(long_state.warning) == 500
    assert AccountState.from_dict(state.as_dict()) == state


async def test_status_and_upload_accept_additive_account_and_unknown_fields():
    account = {"setup_required": True, "setup_expires_at": 1_900_000_000, "warning": WARNING}
    session = FakeSession(FakeResponse(body=status_body() | {"account": account, "future": 1}))
    body = await PowermeshClient(session, API_KEY).status()
    assert parse_account(body) == AccountState(True, 1_900_000_000, WARNING)
    session = FakeSession(FakeResponse(body={
        "accepted": 1, "duplicates": 0, "account": {"setup_required": False}, "future": 1,
    }))
    result = await PowermeshClient(session, API_KEY).upload([{
        "entity_id": "sensor.power",
        "timestamp": "2026-01-01T00:00:00Z",
        "state": 10,
        "unit_of_measurement": "W",
    }])
    assert result == UploadResult(1, 0, None, AccountState(False))


async def test_expired_provisional_key_is_an_ordinary_auth_error():
    session = FakeSession(FakeResponse(status=401, body={"error": {"code": "invalid_token"}}))
    with pytest.raises(PowermeshAuthError) as caught:
        await PowermeshClient(session, API_KEY).status()
    assert (caught.value.code, caught.value.status) == ("invalid_token", 401)


async def start_registration(hass, consents=None):
    hass.states.async_set("sensor.grid_import", "10", ENERGY)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.MENU
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "register"})
    assert result["step_id"] == "register"
    assert result["description_placeholders"]["privacy_url"] == "https://powermesh.de/?r=security"
    assert result["description_placeholders"]["terms_url"] == "https://powermesh.de/?r=terms"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        consents or {"consent_privacy": True, "consent_terms": True, "consent_storage": True},
    )
    if result["step_id"] != "entities":
        return result
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_ENTITIES: ["sensor.grid_import"]}
    )
    assert result["step_id"] == "smoothing"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["step_id"] == "register_account"
    return result


ACCOUNT_INPUT = {
    "email": EMAIL,
    "password": PASSWORD,
    "password_confirm": PASSWORD,
    "invitation_code": INVITATION,
}


@pytest.mark.parametrize("missing", ["consent_privacy", "consent_terms", "consent_storage"])
async def test_registration_requires_each_explicit_consent(hass, missing):
    consents = {"consent_privacy": True, "consent_terms": True, "consent_storage": True} | {missing: False}
    with patch("custom_components.powermesh_energy.config_flow.register_account") as call:
        result = await start_registration(hass, consents)
    assert result["step_id"] == "register"
    assert result["errors"] == {missing: "consent_missing"}
    call.assert_not_called()


async def test_registration_success_creates_entry_once_without_credentials(hass, caplog):
    caplog.set_level(logging.DEBUG)
    expires = future(168 * 3600)
    registration = Registration(API_KEY, AccountState(True, expires, WARNING))
    with patch(
        "custom_components.powermesh_energy.config_flow.register_account",
        AsyncMock(return_value=registration),
    ) as call:
        result = await start_registration(hass)
        with patch("custom_components.powermesh_energy.async_setup_entry", return_value=True):
            result = await hass.config_entries.flow.async_configure(result["flow_id"], ACCOUNT_INPUT)
    assert call.await_count == 1
    assert call.await_args.kwargs == {"email": EMAIL, "password": PASSWORD, "invitation_code": INVITATION}
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_API_KEY: API_KEY, CONF_SETUP_EXPIRES_AT: expires, CONF_STORAGE_MODE: MODE_READINGS}
    assert result["options"][CONF_ENTITIES] == ["sensor.grid_import"]
    assert result["options"][CONF_SMOOTHING] == {"sensor.grid_import": "none"}
    assert result["description"] == "account_setup_required"
    assert result["description_placeholders"]["warning"] == WARNING
    assert result["description_placeholders"]["deadline"] != "?"
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    assert entry.unique_id == KEY_ID
    stored = json.dumps(entry.as_dict(), default=str) + str(result) + caplog.text
    for secret in (EMAIL, PASSWORD, INVITATION):
        assert secret not in stored
    assert not hass.config_entries.flow.async_progress()


async def test_website_pairing_flow_never_collects_account_credentials_in_ha(hass):
    hass.states.async_set("sensor.grid_import", "10", ENERGY)
    expiry = future(1800)
    registration = Registration(API_KEY, AccountState(False))
    with patch("custom_components.powermesh_energy.config_flow.start_pairing", AsyncMock(return_value=Pairing(INVITATION, expiry))) as start, patch(
        "custom_components.powermesh_energy.config_flow.claim_pairing", AsyncMock(side_effect=[None, registration])
    ) as claim:
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "register_website"})
        assert result["step_id"] == "register_website"
        assert set(result["data_schema"].schema) == {vol.Required("continue", default=False)}
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {"continue": True})
        assert result["step_id"] == "entities"
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_ENTITIES: ["sensor.grid_import"]})
        assert result["step_id"] == "smoothing"
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
        assert result["step_id"] == "pairing"
        assert result["description_placeholders"]["code"] == INVITATION
        assert result["description_placeholders"]["url"] == "https://powermesh.de/?r=register&ha=1"
        assert {str(key) for key in result["data_schema"].schema} == {"complete"}
        pending = await hass.config_entries.flow.async_configure(result["flow_id"], {"complete": True})
        assert pending["step_id"] == "pairing"
        assert pending["errors"] == {"base": "pairing_pending"}
        with patch("custom_components.powermesh_energy.async_setup_entry", return_value=True):
            created = await hass.config_entries.flow.async_configure(pending["flow_id"], {"complete": True})
        assert created["type"] is FlowResultType.CREATE_ENTRY
        assert created["data"] == {
            CONF_API_KEY: API_KEY, CONF_STORAGE_MODE: MODE_SNAPSHOT, CONF_PAIRING_LINKED: True,
        }
        assert created["description"] is None
        assert start.await_count == 1 and claim.await_count == 2
        assert claim.await_args.kwargs == {}
        assert claim.await_args.args[1] == start.await_args.args[1]
        assert not hass.config_entries.flow.async_progress()


@pytest.mark.parametrize("code", sorted(REGISTRATION_ERRORS))
async def test_definitive_errors_are_shown_and_never_retried_automatically(hass, code):
    with patch(
        "custom_components.powermesh_energy.config_flow.register_account",
        AsyncMock(side_effect=PowermeshRegistrationError(code, 400)),
    ) as call:
        result = await start_registration(hass)
        result = await hass.config_entries.flow.async_configure(result["flow_id"], ACCOUNT_INPUT)
    assert call.await_count == 1
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "register_account"
    assert result["errors"] == {"base": code}
    defaults = {str(key): key.default() for key in result["data_schema"].schema if callable(key.default)}
    assert PASSWORD not in defaults.values() and INVITATION not in defaults.values()
    assert not hass.config_entries.async_entries(DOMAIN)


@pytest.mark.parametrize(
    "error",
    [PowermeshRegistrationError("registration_uncertain", uncertain=True), RuntimeError("synthetic")],
)
async def test_ambiguous_outcome_aborts_with_warning_and_single_call(hass, error):
    with patch(
        "custom_components.powermesh_energy.config_flow.register_account",
        AsyncMock(side_effect=error),
    ) as call:
        result = await start_registration(hass)
        result = await hass.config_entries.flow.async_configure(result["flow_id"], ACCOUNT_INPUT)
    assert call.await_count == 1
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "registration_uncertain"
    assert not hass.config_entries.async_entries(DOMAIN)


@pytest.mark.parametrize(
    ("changes", "errors"),
    [
        ({"email": "not-an-address"}, {"email": "invalid_email"}),
        ({"password_confirm": "different"}, {"password_confirm": "password_mismatch"}),
        ({"invitation_code": "   "}, {"invitation_code": "invitation_required"}),
    ],
)
async def test_local_validation_does_not_contact_service(hass, changes, errors):
    with patch("custom_components.powermesh_energy.config_flow.register_account") as call:
        result = await start_registration(hass)
        result = await hass.config_entries.flow.async_configure(result["flow_id"], ACCOUNT_INPUT | changes)
    assert result["errors"] == errors
    call.assert_not_called()


def make_registered_uploader(hass, *, seed=None, stored=None):
    data = {CONF_API_KEY: API_KEY}
    if seed is not None:
        data[CONF_SETUP_EXPIRES_AT] = seed
    entry = MockConfigEntry(domain=DOMAIN, data=data, options={
        CONF_ENTITIES: ["sensor.grid_import"], CONF_SMOOTHING: {"sensor.grid_import": "none"},
    })
    entry.add_to_hass(hass)
    client = AsyncMock(spec=PowermeshClient)
    client.key_id = KEY_ID
    client.base_url = "https://api.powermesh.de"
    client.status.return_value = status_body()
    client.upload.return_value = UploadResult(1, 0)
    uploader = PowermeshUploader(hass, entry, client)
    entry.runtime_data = uploader
    uploader._store = MagicMock()
    uploader._store.async_load = AsyncMock(return_value=stored)
    uploader._store.async_save = AsyncMock()
    return uploader, client, entry


def issue(hass, name, entry):
    return ir.async_get(hass).async_get_issue(DOMAIN, f"{name}_{entry.entry_id}")


async def test_setup_issue_persists_until_server_confirms_completion(hass):
    expires = future()
    uploader, client, entry = make_registered_uploader(hass, seed=expires)
    client.status.side_effect = PowermeshConnectionError("cannot_connect")
    await uploader.async_start()
    pending = issue(hass, "account_setup_required", entry)
    assert pending is not None and pending.is_persistent
    assert pending.severity is ir.IssueSeverity.WARNING
    assert pending.translation_placeholders["deadline"] != "?"
    client.status.side_effect = None
    client.status.return_value = status_body() | {"account": {
        "setup_required": True, "setup_expires_at": expires, "warning": WARNING,
    }}
    assert await uploader.async_check_version()
    assert issue(hass, "account_setup_required", entry).translation_placeholders["warning"] == WARNING
    client.status.return_value = status_body()
    assert await uploader.async_check_version()
    assert issue(hass, "account_setup_required", entry) is not None
    client.status.return_value = status_body() | {"account": {
        "setup_required": False, "setup_expires_at": None, "warning": None,
    }}
    assert await uploader.async_check_version()
    assert issue(hass, "account_setup_required", entry) is None
    assert uploader._data()["account"] == {"setup_required": False, "setup_expires_at": None, "warning": None}
    await uploader.async_stop()


async def test_restart_restores_setup_issue_from_private_storage(hass):
    expires = future()
    stored = {
        "transport": REST_BUFFER_FORMAT, "readings": [], "owner": KEY_ID, "inflight": None,
        "account": {"setup_required": True, "setup_expires_at": expires, "warning": WARNING},
    }
    uploader, client, entry = make_registered_uploader(hass, stored=stored)
    client.status.side_effect = PowermeshConnectionError("cannot_connect")
    await uploader.async_start()
    restored = issue(hass, "account_setup_required", entry)
    assert restored is not None
    assert restored.translation_placeholders["warning"] == WARNING
    await uploader.async_stop()


async def test_upload_response_clears_setup_issue(hass):
    uploader, client, entry = make_registered_uploader(hass, seed=future())
    await uploader.async_start()
    await hass.async_block_till_done()
    assert issue(hass, "account_setup_required", entry) is not None
    uploader._append(reading())
    client.upload.return_value = UploadResult(1, 0, None, AccountState(False))
    await uploader.async_upload()
    assert issue(hass, "account_setup_required", entry) is None
    await uploader.async_stop()


async def test_expired_account_is_visible_auth_problem_without_reregistration(hass):
    uploader, client, entry = make_registered_uploader(hass, seed=future(-60))
    client.status.side_effect = PowermeshAuthError("invalid_token", 401)
    with (
        patch.object(entry, "async_start_reauth") as reauth,
        patch("custom_components.powermesh_energy.config_flow.register_account") as call,
    ):
        await uploader.async_start()
    expired = issue(hass, "account_setup_expired", entry)
    assert expired is not None and expired.severity is ir.IssueSeverity.ERROR
    assert issue(hass, "account_setup_required", entry) is None
    assert uploader.status == "auth_failed" and uploader._paused
    reauth.assert_called_once()
    call.assert_not_called()
    await uploader.async_stop()


async def test_auth_failure_before_deadline_keeps_setup_warning(hass):
    uploader, client, entry = make_registered_uploader(hass, seed=future())
    client.status.side_effect = PowermeshAuthError("invalid_token", 401)
    with patch.object(entry, "async_start_reauth"):
        await uploader.async_start()
    assert issue(hass, "account_setup_required", entry) is not None
    assert issue(hass, "account_setup_expired", entry) is None
    assert uploader.status == "auth_failed"
    await uploader.async_stop()


async def test_malformed_registration_status_keeps_key_and_reports_protocol_error(hass, caplog):
    caplog.set_level(logging.DEBUG)
    with patch(
        "custom_components.powermesh_energy.config_flow.register_account",
        AsyncMock(return_value=Registration(API_KEY, None)),
    ) as call:
        result = await start_registration(hass)
        with patch("custom_components.powermesh_energy.async_setup_entry", return_value=True):
            result = await hass.config_entries.flow.async_configure(result["flow_id"], ACCOUNT_INPUT)
    assert call.await_count == 1
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_API_KEY: API_KEY, CONF_ACCOUNT_STATUS_UNKNOWN: True, CONF_STORAGE_MODE: MODE_READINGS}
    assert result["description"] == "account_status_unknown"
    assert "deadline" not in result["description_placeholders"]
    stored = str(result) + caplog.text
    for secret in (EMAIL, PASSWORD, INVITATION):
        assert secret not in stored


async def test_unknown_account_status_issue_until_server_reports(hass):
    uploader, client, entry = make_registered_uploader(hass)
    hass.config_entries.async_update_entry(
        entry, data=entry.data | {CONF_ACCOUNT_STATUS_UNKNOWN: True}
    )
    client.status.side_effect = PowermeshConnectionError("cannot_connect")
    await uploader.async_start()
    unknown = issue(hass, "account_status_unknown", entry)
    assert unknown is not None and unknown.is_persistent
    assert unknown.severity is ir.IssueSeverity.WARNING
    client.status.side_effect = None
    expires = future()
    client.status.return_value = status_body() | {"account": {
        "setup_required": True, "setup_expires_at": expires, "warning": WARNING,
    }}
    assert await uploader.async_check_version()
    assert issue(hass, "account_status_unknown", entry) is None
    assert issue(hass, "account_setup_required", entry) is not None
    client.status.return_value = status_body() | {"account": {
        "setup_required": False, "setup_expires_at": None, "warning": None,
    }}
    assert await uploader.async_check_version()
    for name in ("account_status_unknown", "account_setup_required", "account_setup_expired"):
        assert issue(hass, name, entry) is None
    await uploader.async_stop()


async def test_ordinary_entries_have_no_setup_issue(hass):
    uploader, client, entry = make_registered_uploader(hass)
    client.status.return_value = status_body() | {"account": {
        "setup_required": False, "setup_expires_at": None, "warning": None,
    }}
    await uploader.async_start()
    await hass.async_block_till_done()
    assert issue(hass, "account_setup_required", entry) is None
    assert issue(hass, "account_setup_expired", entry) is None
    await uploader.async_stop()


def test_translations_cover_registration_keys():
    files = [COMPONENT / "strings.json", COMPONENT / "translations" / "en.json", COMPONENT / "translations" / "de.json"]
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        config = data["config"]
        assert set(config["step"]["user"]["menu_options"]) == {"monitor", "local", "api_key", "register_website", "register"}
        assert set(config["step"]["register_website"]["data"]) == {"continue"}
        assert set(config["step"]["pairing"]["data"]) == {"complete", "restart"}
        assert set(config["step"]["register"]["data"]) == {"consent_privacy", "consent_terms", "consent_storage"}
        assert set(config["step"]["register_account"]["data"]) == set(ACCOUNT_INPUT)
        for code in REGISTRATION_ERRORS | {
            "consent_missing", "invalid_email", "password_required", "password_mismatch",
            "invitation_required", "registration_in_progress",
            "pairing_pending",
        }:
            assert code in config["error"], (path, code)
        assert {"registration_uncertain", "registration_incomplete"} <= set(config["abort"])
        assert "{deadline}" in config["create_entry"]["account_setup_required"]
        assert "{deadline}" not in config["create_entry"]["account_status_unknown"]
        for key in ("account_setup_required", "account_setup_expired"):
            assert "{deadline}" in data["issues"][key]["description"]
        assert "{deadline}" not in data["issues"]["account_status_unknown"]["description"]
    german = json.loads(files[2].read_text(encoding="utf-8"))
    assert "Nutzungsbedingungen von powermesh.de" in german["config"]["step"]["register"]["description"]
