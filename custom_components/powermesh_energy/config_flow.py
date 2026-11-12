"""Config and options flow for Powermesh Energie."""

from __future__ import annotations

from collections.abc import Mapping
import re
import secrets
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from homeassistant.helpers.selector import (
    BooleanSelector,
    EntitySelector,
    EntitySelectorConfig,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .api import (
    PowermeshAuthError,
    PowermeshClient,
    PowermeshConnectionError,
    PowermeshError,
    PowermeshForbiddenError,
    PowermeshOutdatedError,
    PowermeshRateLimitError,
    PowermeshRegistrationError,
    Registration,
    claim_pairing,
    register_account,
    start_pairing,
    validate_connection,
    validate_status,
)
from .const import (
    ACCOUNT_SETUP_HOURS,
    CONF_ACCOUNT_STATUS_UNKNOWN,
    CONF_API_KEY,
    CONF_STORAGE_MODE,
    CONF_PAIRING_LINKED,
    MODE_READINGS,
    MODE_SNAPSHOT,
    CONF_ENTITIES,
    CONF_SETUP_EXPIRES_AT,
    CONF_SMOOTHING,
    CONF_UPLOAD_INTERVAL,
    CONF_USE_SUGGESTION,
    DEFAULT_UPLOAD_INTERVAL,
    CONF_MODE,
    MODE_LOCAL,
    CONF_ROLES,
    LOCAL_ROLES,
    MAX_READINGS_PER_REQUEST,
    DOMAIN,
    PAIRING_STORE,
    PAIRING_URL,
    STORAGE_VERSION,
    INTERVAL_OPTIONS,
    PRIVACY_URL,
    TERMS_URL,
    WEBSITE_URL,
)
from . import const
from .const import MODE_MONITOR
from .energy_dashboard import async_suggestion
from .monitor_flow import MonitorFlowMixin
from .readings import ENTITY_ID_PATTERN
from .smoothing import OPTIONS as SMOOTHING_OPTIONS, option_for
from .uploader import account_issue_placeholders

CONF_EMAIL = "email"
CONF_PASSWORD = "password"
CONF_PASSWORD_CONFIRM = "password_confirm"
CONF_INVITATION_CODE = "invitation_code"
CONF_CONSENT_PRIVACY = "consent_privacy"
CONF_CONSENT_TERMS = "consent_terms"
CONF_CONSENT_STORAGE = "consent_storage"
CONSENT_FIELDS = (CONF_CONSENT_PRIVACY, CONF_CONSENT_TERMS, CONF_CONSENT_STORAGE)
EMAIL_PATTERN = re.compile(r"[^@\s]{1,64}@[^@\s]+\.[^@\s]+")
MAX_EMAIL_LENGTH = 254
MAX_PASSWORD_LENGTH = 4096
MAX_INVITATION_LENGTH = 256
REGISTRATION_ERRORS = frozenset({
    "account_exists",
    "cannot_connect",
    "invalid_registration",
    "invitation_invalid",
    "registration_rate_limited",
    "registration_rejected",
    "registration_unavailable",
    "registration_uncertain",
    "consent_required",
    "pairing_used",
    "pairing_expired",
    "update_required",
})

REASONS_DE = {
    "external_statistic": "externe Statistik, keine Entität",
    "missing": "derzeit kein Zustand",
    "entity_id": "keine sensor-Entität",
    "device_class": "Geräteklasse nicht Energie/Leistung",
    "unit": "Einheit nicht unterstützt",
    "state_class": "Zustandsklasse nicht unterstützt",
}


async def _async_validate(hass: HomeAssistant, data: Mapping[str, Any]) -> dict[str, str]:
    """Verify the personal API key over HTTPS."""
    try:
        validate_connection(data[CONF_API_KEY])
    except (ValueError, KeyError):
        return {"base": "invalid_auth"}
    try:
        status = await PowermeshClient(
            async_get_clientsession(hass), data[CONF_API_KEY].strip()
        ).status()
        validate_status(status)
    except PowermeshOutdatedError:
        return {"base": "api_incompatible"}
    except PowermeshAuthError:
        return {"base": "invalid_auth"}
    except PowermeshForbiddenError:
        return {"base": "consent_required"}
    except PowermeshRateLimitError:
        return {"base": "rate_limited"}
    except PowermeshConnectionError:
        return {"base": "cannot_connect"}
    except PowermeshError:
        return {"base": "unknown"}
    return {}


def _connection_schema(data: Mapping[str, Any]) -> vol.Schema:
    return vol.Schema({
        vol.Required(CONF_API_KEY, default=data.get(CONF_API_KEY, "")): TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD)
        ),
    })


def _consent_schema() -> vol.Schema:
    return vol.Schema({vol.Required(field, default=False): BooleanSelector() for field in CONSENT_FIELDS})


def _account_schema(email: str) -> vol.Schema:
    # Password and invitation code are never prefilled.
    return vol.Schema({
        vol.Required(CONF_EMAIL, default=email): TextSelector(
            TextSelectorConfig(type=TextSelectorType.EMAIL, autocomplete="email")
        ),
        vol.Required(CONF_PASSWORD): TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD, autocomplete="new-password")
        ),
        vol.Required(CONF_PASSWORD_CONFIRM): TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD, autocomplete="new-password")
        ),
        vol.Required(CONF_INVITATION_CODE): TextSelector(
            TextSelectorConfig(type=TextSelectorType.PASSWORD, autocomplete="off")
        ),
    })


def _account_errors(email: str, password: Any, confirm: Any, code: str) -> dict[str, str]:
    if len(email) > MAX_EMAIL_LENGTH or EMAIL_PATTERN.fullmatch(email) is None:
        return {CONF_EMAIL: "invalid_email"}
    if not isinstance(password, str) or not password or len(password) > MAX_PASSWORD_LENGTH:
        return {CONF_PASSWORD: "password_required"}
    if password != confirm:
        return {CONF_PASSWORD_CONFIRM: "password_mismatch"}
    if not code or len(code) > MAX_INVITATION_LENGTH:
        return {CONF_INVITATION_CODE: "invitation_required"}
    return {}


def _entity_schema(default_entities: list[str], default_interval: str = DEFAULT_UPLOAD_INTERVAL) -> vol.Schema:
    if default_interval not in INTERVAL_OPTIONS:
        default_interval = DEFAULT_UPLOAD_INTERVAL
    return vol.Schema(
        {
            vol.Optional(CONF_ENTITIES, default=default_entities): EntitySelector(
                EntitySelectorConfig(domain="sensor", multiple=True)
            ),
            vol.Optional(CONF_UPLOAD_INTERVAL, default=default_interval): SelectSelector(
                SelectSelectorConfig(
                    options=[SelectOptionDict(value=opt, label=opt) for opt in INTERVAL_OPTIONS],
                    mode=SelectSelectorMode.DROPDOWN,
                )
            ),
        }
    )


def _local_schema(hass: HomeAssistant, defaults: Mapping[str, Any]) -> vol.Schema:
    schema = {}
    for role in LOCAL_ROLES:
        units = {"%"} if role == "battery_soc" else {"W", "kW"}
        candidates = [state.entity_id for state in hass.states.async_all("sensor")
                      if state.attributes.get("unit_of_measurement") in units]
        key = vol.Optional(role, description={"suggested_value": defaults[role]}) if defaults.get(role) else vol.Optional(role)
        schema[key] = EntitySelector(EntitySelectorConfig(domain="sensor", include_entities=candidates))
    return vol.Schema(schema)


def _local_errors(hass: HomeAssistant, roles: Mapping[str, Any]) -> dict[str, str]:
    if not any(roles.values()):
        return {"base": "no_entities"}
    errors = {}
    selected = set()
    for role, entity_id in roles.items():
        if role not in LOCAL_ROLES or not entity_id:
            continue
        state = hass.states.get(entity_id) if isinstance(entity_id, str) else None
        units = {"%"} if role == "battery_soc" else {"W", "kW"}
        if state is None or not entity_id.startswith("sensor.") or state.attributes.get("unit_of_measurement") not in units:
            errors[role] = "invalid_source"
        elif entity_id in selected:
            errors[role] = "duplicate_source"
        selected.add(entity_id)
    return errors


def _is_energy_entity(hass: HomeAssistant | None, entity_id: str) -> bool:
    """Return True if the entity is an energy counter (device_class: energy)."""
    if hass is None:
        return False
    state = hass.states.get(entity_id)
    if state is not None and isinstance(state.attributes.get("device_class"), str):
        if state.attributes["device_class"].casefold() == "energy":
            return True
    try:
        from homeassistant.helpers import entity_registry as er

        entry = er.async_get(hass).async_get(entity_id)
        if entry is not None:
            for attr in (entry.device_class, entry.original_device_class):
                if isinstance(attr, str) and attr.casefold() == "energy":
                    return True
    except Exception:  # noqa: BLE001
        pass
    return False


def _smoothing_schema(entities: list[str], choices: Mapping[str, Any] | None, hass: HomeAssistant | None = None) -> vol.Schema:
    """Build smoothing schema, forcing 'none' for energy sensors (device_class: energy).
    
    Energy sensors (counter reads) must never be smoothed to prevent data corruption.
    The API validates and rejects energy+smoothing combinations; this UI layer
    prevents misconfiguration at source.
    """
    selector = SelectSelector(
        SelectSelectorConfig(
            options=list(SMOOTHING_OPTIONS),
            mode=SelectSelectorMode.DROPDOWN,
            translation_key="smoothing",
        )
    )
    none_selector = SelectSelector(
        SelectSelectorConfig(
            options=["none"],
            mode=SelectSelectorMode.DROPDOWN,
            translation_key="smoothing",
        )
    )
    schema_dict = {}
    for entity in entities:
        if _is_energy_entity(hass, entity):
            schema_dict[vol.Required(entity, default="none")] = none_selector
        else:
            schema_dict[vol.Required(entity, default=option_for(choices, entity))] = selector
    
    return vol.Schema(schema_dict)


def _smoothing_choices(entities: list[str], user_input: Mapping[str, Any], hass: HomeAssistant | None = None) -> dict[str, str]:
    """Extract smoothing choices, forcing 'none' for energy sensors.
    
    When reconfiguring, checks if existing smoothing was incorrectly applied
    to energy sensors and corrects it to 'none'.
    """
    choices_dict = {}
    for entity in entities:
        if _is_energy_entity(hass, entity):
            # Energy sensors must never be smoothed; force 'none' regardless of prior config
            choices_dict[entity] = "none"
        else:
            choices_dict[entity] = option_for(user_input, entity)
    
    return choices_dict


def _describe(suggestion: list[str], skipped: dict[str, str]) -> dict[str, str]:
    lines = [f"- `{entity}`" for entity in suggestion] or ["- (keine passenden Entitäten gefunden)"]
    skipped_lines = [f"- `{entity}`: {REASONS_DE.get(reason, reason)}" for entity, reason in list(skipped.items())[:15]]
    return {
        "suggestion": "\n".join(lines),
        "skipped": "\n".join(skipped_lines) or "- keine",
    }


def _incompatible(hass: HomeAssistant, entities: list[str]) -> list[str]:
    return [
        entity
        for entity in entities
        if not isinstance(entity, str) or not ENTITY_ID_PATTERN.fullmatch(entity)
    ]


def _cloud_disabled(flow: ConfigFlow | OptionsFlow) -> ConfigFlowResult | None:
    """Refuse cloud steps while the REST transfer is disabled."""
    if const.CLOUD_TRANSFER_ENABLED:
        return None
    return flow.async_abort(reason="cloud_transfer_disabled")


class PowermeshConfigFlow(MonitorFlowMixin, ConfigFlow, domain=DOMAIN):
    """Set up local monitoring, the local overview or (when enabled) powermesh.de."""

    VERSION = 1

    def __init__(self) -> None:
        self._connection: dict[str, Any] = {}
        self._options: dict[str, Any] = {}
        self._registering = False
        self._registration_in_progress = False
        self._registration_sent = False
        self._website_pairing = False
        self._pairing_secret: str | None = None
        self._pairing_code: str | None = None
        self._pairing_expires: int | None = None
        self._pairing_used = False

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Choose local monitoring, the local overview or (when enabled) a cloud connection."""
        menu = ["monitor", "local"]
        if const.CLOUD_TRANSFER_ENABLED:
            menu += ["api_key", "register_website", "register"]
        return self.async_show_menu(step_id="user", menu_options=menu)

    async def async_step_monitor(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Allow only one monitoring entry."""
        await self.async_set_unique_id(f"{DOMAIN}_monitor")
        self._abort_if_unique_id_configured()
        return await super().async_step_monitor(user_input)

    async def _async_finish_monitor(self, options: dict[str, Any]) -> ConfigFlowResult:
        return self.async_create_entry(title="Powermesh Auffälligkeiten", data={CONF_MODE: MODE_MONITOR}, options=options)

    async def async_step_local(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Configure a local overview without credentials or transport."""
        roles = {role: user_input[role] for role in LOCAL_ROLES if user_input and user_input.get(role)}
        errors = _local_errors(self.hass, roles) if user_input is not None else {}
        if user_input is not None and not errors:
            await self.async_set_unique_id(f"{DOMAIN}_local")
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title="Powermesh Energie", data={CONF_MODE: MODE_LOCAL}, options={CONF_ROLES: roles})
        return self.async_show_form(step_id="local", data_schema=_local_schema(self.hass, roles), errors=errors)

    async def async_step_api_key(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Ask for a personal API key."""
        if disabled := _cloud_disabled(self):
            return disabled
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = await _async_validate(self.hass, user_input)
            if not errors:
                api_key = user_input[CONF_API_KEY].strip()
                await self.async_set_unique_id(api_key.split("_", 2)[1])
                self._abort_if_unique_id_configured()
                self._connection = {CONF_API_KEY: api_key, CONF_STORAGE_MODE: MODE_SNAPSHOT}
                return await self.async_step_entities()
        return self.async_show_form(
            step_id="api_key",
            data_schema=_connection_schema(user_input or {}),
            errors=errors,
        )

    async def async_step_register_website(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Prepare selected sensors, then link a new account on the website."""
        if disabled := _cloud_disabled(self):
            return disabled
        errors: dict[str, str] = {}
        if user_input is not None:
            if user_input.get("continue") is True:
                await self.async_set_unique_id(f"{DOMAIN}_website_pairing")
                self._abort_if_unique_id_configured()
                self._registering = True
                self._website_pairing = True
                self._connection = {CONF_STORAGE_MODE: MODE_SNAPSHOT}
                return await self.async_step_entities()
            errors = {"base": "consent_missing"}
        return self.async_show_form(
            step_id="register_website",
            data_schema=vol.Schema({vol.Required("continue", default=False): BooleanSelector()}),
            errors=errors,
            description_placeholders={"url": PAIRING_URL},
        )

    async def async_step_register(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Keep the operator-issued invitation flow available as a fallback."""
        if disabled := _cloud_disabled(self):
            return disabled
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = {field: "consent_missing" for field in CONSENT_FIELDS if user_input.get(field) is not True}
            if not errors:
                self._registering = True
                self._website_pairing = False
                self._connection = {CONF_STORAGE_MODE: MODE_READINGS}
                return await self.async_step_entities()
        return self.async_show_form(
            step_id="register", data_schema=_consent_schema(), errors=errors,
            description_placeholders={"privacy_url": PRIVACY_URL, "terms_url": TERMS_URL, "hours": str(ACCOUNT_SETUP_HOURS)},
        )

    async def async_step_register_account(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Send the single registration request and keep the issued key at once."""
        if disabled := _cloud_disabled(self):
            return disabled
        if self._registration_sent:
            return self.async_abort(reason="registration_uncertain")
        if not self._registering or CONF_SMOOTHING not in self._options:
            return self.async_abort(reason="registration_incomplete")
        errors: dict[str, str] = {}
        email = ""
        if user_input is not None:
            email = str(user_input.get(CONF_EMAIL, "")).strip()
            code = str(user_input.get(CONF_INVITATION_CODE, "")).strip()
            errors = _account_errors(
                email, user_input.get(CONF_PASSWORD), user_input.get(CONF_PASSWORD_CONFIRM), code
            )
            if not errors and self._registration_in_progress:
                errors = {"base": "registration_in_progress"}
            if not errors:
                self._registration_in_progress = True
                try:
                    registration = await register_account(
                        async_get_clientsession(self.hass),
                        email=email,
                        password=user_input[CONF_PASSWORD],
                        invitation_code=code,
                    )
                except PowermeshRegistrationError as err:
                    if err.uncertain:
                        self._registration_sent = True
                        return self.async_abort(reason="registration_uncertain")
                    errors = {"base": err.code if err.code in REGISTRATION_ERRORS else "registration_rejected"}
                except Exception:  # noqa: BLE001 - never resubmit after an unknown outcome
                    self._registration_sent = True
                    return self.async_abort(reason="registration_uncertain")
                else:
                    self._registration_sent = True
                    return await self._async_create_registered_entry(registration)
                finally:
                    self._registration_in_progress = False
        return self.async_show_form(
            step_id="register_account",
            data_schema=_account_schema(email),
            errors=errors,
            description_placeholders={"url": WEBSITE_URL, "hours": str(ACCOUNT_SETUP_HOURS)},
        )

    async def _async_create_registered_entry(self, registration: Registration) -> ConfigFlowResult:
        account = registration.account
        await self.async_set_unique_id(registration.api_key.split("_", 2)[1], raise_on_progress=False)
        data: dict[str, Any] = {CONF_API_KEY: registration.api_key}
        data[CONF_STORAGE_MODE] = MODE_SNAPSHOT if self._website_pairing else self._connection.get(CONF_STORAGE_MODE, MODE_READINGS)
        if self._website_pairing:
            data[CONF_PAIRING_LINKED] = True
            data[CONF_STORAGE_MODE] = MODE_SNAPSHOT
        if account is None:
            # Protocol error: keep the one-time key, report it, never invent a deadline.
            data[CONF_ACCOUNT_STATUS_UNKNOWN] = True
            return self.async_create_entry(
                title="Powermesh Energie",
                data=data,
                options=self._options,
                description="account_status_unknown",
                description_placeholders={"url": WEBSITE_URL, "hours": str(ACCOUNT_SETUP_HOURS)},
            )
        if account.setup_required and account.setup_expires_at is not None:
            data[CONF_SETUP_EXPIRES_AT] = account.setup_expires_at
        return self.async_create_entry(
            title="Powermesh Energie",
            data=data,
            options=self._options,
            description="account_setup_required" if account.setup_required else None,
            description_placeholders=account_issue_placeholders(account),
        )

    async def async_step_entities(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Propose entities from the energy dashboard; the user may adjust them."""
        if disabled := _cloud_disabled(self):
            return disabled
        suggestion, skipped = await async_suggestion(self.hass)
        errors: dict[str, str] = {}
        placeholders = _describe(suggestion, skipped) | {"invalid": ""}
        if user_input is not None:
            selected = list(user_input.get(CONF_ENTITIES, []))
            interval = str(user_input.get(CONF_UPLOAD_INTERVAL, DEFAULT_UPLOAD_INTERVAL))
            if interval not in INTERVAL_OPTIONS:
                interval = DEFAULT_UPLOAD_INTERVAL
            if not selected:
                errors["base"] = "no_entities"
            elif self._connection.get(CONF_STORAGE_MODE) == MODE_SNAPSHOT and len(selected) > MAX_READINGS_PER_REQUEST:
                errors["base"] = "snapshot_limit"
            elif invalid := _incompatible(self.hass, selected):
                errors["base"] = "incompatible"
                placeholders["invalid"] = ", ".join(invalid)
            else:
                self._options = {CONF_ENTITIES: selected, CONF_UPLOAD_INTERVAL: interval}
                return await self.async_step_smoothing()
        default_entities = list(user_input.get(CONF_ENTITIES, [])) if user_input else suggestion
        default_interval = (
            str(user_input.get(CONF_UPLOAD_INTERVAL, DEFAULT_UPLOAD_INTERVAL))
            if user_input
            else DEFAULT_UPLOAD_INTERVAL
        )
        return self.async_show_form(
            step_id="entities",
            data_schema=_entity_schema(default_entities, default_interval),
            errors=errors,
            description_placeholders=placeholders,
        )

    async def async_step_smoothing(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Choose the smoothing per entity (default: 1 min mean)."""
        if disabled := _cloud_disabled(self):
            return disabled
        entities = self._options[CONF_ENTITIES]
        if user_input is not None and self._registering:
            self._options = self._options | {CONF_SMOOTHING: _smoothing_choices(entities, user_input, self.hass)}
            if self._website_pairing:
                return await self._async_start_pairing()
            return await self.async_step_register_account()
        if user_input is not None:
            return self.async_create_entry(
                title="Powermesh Energie",
                data=self._connection,
                options=self._options | {CONF_SMOOTHING: _smoothing_choices(entities, user_input, self.hass)},
            )
        return self.async_show_form(step_id="smoothing", data_schema=_smoothing_schema(entities, None, self.hass))

    async def _async_start_pairing(self, *, reset_secret: bool = False) -> ConfigFlowResult:
        store = Store(self.hass, STORAGE_VERSION, PAIRING_STORE, private=True)
        stored = await store.async_load()
        secret = stored.get("installation_secret") if isinstance(stored, dict) and not reset_secret else None
        if not isinstance(secret, str) or re.fullmatch(r"[a-f0-9]{64}", secret) is None:
            secret = secrets.token_hex(32)
            await store.async_save({"installation_secret": secret})
        self._pairing_secret = secret
        self._pairing_code = None
        self._pairing_expires = None
        self._pairing_used = False
        try:
            pairing = await start_pairing(async_get_clientsession(self.hass), secret)
        except PowermeshRegistrationError as err:
            if err.code == "pairing_used":
                self._pairing_code = ""
                self._pairing_used = True
                return await self._show_pairing({"base": "pairing_pending"})
            code = err.code if err.code in REGISTRATION_ERRORS else "registration_rejected"
            return await self._show_pairing({"base": code})
        self._pairing_code = pairing.code
        self._pairing_expires = pairing.expires_at
        await store.async_save({"installation_secret": secret, "expires_at": pairing.expires_at})
        return await self._show_pairing()

    async def _show_pairing(self, errors: dict[str, str] | None = None) -> ConfigFlowResult:
        fields = {vol.Required("complete", default=False): BooleanSelector()}
        if self._pairing_used:
            fields[vol.Optional("restart", default=False)] = BooleanSelector()
        return self.async_show_form(
            step_id="pairing",
            data_schema=vol.Schema(fields),
            errors=errors or {},
            description_placeholders={
                "code": self._pairing_code or "",
                "expires": dt_util.as_local(dt_util.utc_from_timestamp(self._pairing_expires)).strftime("%d.%m.%Y %H:%M %Z")
                if self._pairing_expires else "",
                "url": PAIRING_URL,
            },
        )

    async def async_step_pairing(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Claim the API key only after the website confirms email and MFA setup."""
        if disabled := _cloud_disabled(self):
            return disabled
        if not self._website_pairing or CONF_SMOOTHING not in self._options:
            return self.async_abort(reason="registration_incomplete")
        if not self._pairing_secret:
            stored = await Store(self.hass, STORAGE_VERSION, PAIRING_STORE, private=True).async_load()
            secret = stored.get("installation_secret") if isinstance(stored, dict) else None
            if not isinstance(secret, str) or re.fullmatch(r"[a-f0-9]{64}", secret) is None:
                return self.async_abort(reason="registration_incomplete")
            self._pairing_secret = secret
        if user_input is None:
            return await self._show_pairing()
        if user_input.get("restart") is True:
            return await self._async_start_pairing(reset_secret=True)
        if user_input.get("complete") is not True:
            return await self._show_pairing({"base": "pairing_pending"})
        if not self._pairing_code:
            return await self._async_start_pairing()
        try:
            registration = await claim_pairing(async_get_clientsession(self.hass), self._pairing_secret)
        except PowermeshRegistrationError as err:
            if err.code == "pairing_expired":
                refreshed = await self._async_start_pairing()
                refreshed["errors"] = {"base": "pairing_expired"}
                return refreshed
            if err.code == "pairing_used":
                self._pairing_used = True
            code = err.code if err.code in REGISTRATION_ERRORS else "registration_rejected"
            return await self._show_pairing({"base": code})
        if registration is None:
            return await self._show_pairing({"base": "pairing_pending"})
        return await self._async_create_registered_entry(registration)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The stored key was rejected."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """New credentials do not silently authorize previously buffered data."""
        if disabled := _cloud_disabled(self):
            return disabled
        entry = self.hass.config_entries.async_get_entry(self.context["entry_id"])
        assert entry is not None
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = await _async_validate(self.hass, user_input)
            if not errors:
                api_key = user_input[CONF_API_KEY].strip()
                connection = {CONF_API_KEY: api_key, CONF_STORAGE_MODE: entry.data.get(CONF_STORAGE_MODE, MODE_READINGS)}
                return self.async_update_reload_and_abort(
                    entry, data=connection,
                    unique_id=api_key.split("_", 2)[1],
                )
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=_connection_schema(entry.data),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        """Allow adjusting the transferred entities later."""
        return PowermeshOptionsFlow()


class PowermeshOptionsFlow(MonitorFlowMixin, OptionsFlow):
    """Adjust monitoring, the local overview or the transferred entities."""

    def __init__(self) -> None:
        self._options: dict[str, Any] = {}

    def _monitor_current(self) -> dict[str, Any]:
        return dict(self.config_entry.options)

    async def _async_finish_monitor(self, options: dict[str, Any]) -> ConfigFlowResult:
        return self.async_create_entry(data=options)

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show current selection, optionally reset to the dashboard suggestion."""
        if self.config_entry.data.get(CONF_MODE) == MODE_MONITOR:
            return await self.async_step_monitor(user_input)
        if self.config_entry.data.get(CONF_MODE) == MODE_LOCAL:
            return await self.async_step_local(user_input)
        if disabled := _cloud_disabled(self):
            return disabled
        suggestion, skipped = await async_suggestion(self.hass)
        placeholders = _describe(suggestion, skipped) | {"invalid": ""}
        errors: dict[str, str] = {}
        default_entities = list(self.config_entry.options.get(CONF_ENTITIES, []))
        default_interval = str(self.config_entry.options.get(CONF_UPLOAD_INTERVAL, DEFAULT_UPLOAD_INTERVAL))
        if default_interval not in INTERVAL_OPTIONS:
            default_interval = DEFAULT_UPLOAD_INTERVAL
        if user_input is not None:
            selected = list(user_input.get(CONF_ENTITIES, []))
            interval = str(user_input.get(CONF_UPLOAD_INTERVAL, default_interval))
            if interval not in INTERVAL_OPTIONS:
                interval = DEFAULT_UPLOAD_INTERVAL
            if user_input.get(CONF_USE_SUGGESTION):
                default_entities = suggestion
                default_interval = interval
            elif not selected:
                errors["base"] = "no_entities"
                default_entities = selected
                default_interval = interval
            elif self.config_entry.data.get(CONF_STORAGE_MODE) == MODE_SNAPSHOT and len(selected) > MAX_READINGS_PER_REQUEST:
                errors["base"] = "snapshot_limit"
                default_entities = selected
                default_interval = interval
            elif invalid := _incompatible(self.hass, selected):
                errors["base"] = "incompatible"
                placeholders["invalid"] = ", ".join(invalid)
                default_entities = selected
                default_interval = interval
            else:
                self._options = {CONF_ENTITIES: selected, CONF_UPLOAD_INTERVAL: interval}
                return await self.async_step_smoothing()
        schema = _entity_schema(default_entities, default_interval).extend(
            {vol.Optional(CONF_USE_SUGGESTION, default=False): BooleanSelector()}
        )
        return self.async_show_form(
            step_id="init", data_schema=schema, errors=errors, description_placeholders=placeholders
        )

    async def async_step_local(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        roles = {role: user_input[role] for role in LOCAL_ROLES if user_input and user_input.get(role)}
        errors = _local_errors(self.hass, roles) if user_input is not None else {}
        if user_input is not None and not errors:
            return self.async_create_entry(data={CONF_ROLES: roles})
        defaults = roles if user_input is not None else self.config_entry.options.get(CONF_ROLES, {})
        return self.async_show_form(step_id="local", data_schema=_local_schema(self.hass, defaults), errors=errors)

    async def async_step_smoothing(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Choose the smoothing per entity; new entities start with the default."""
        if disabled := _cloud_disabled(self):
            return disabled
        entities = self._options[CONF_ENTITIES]
        if user_input is not None:
            return self.async_create_entry(data=self._options | {CONF_SMOOTHING: _smoothing_choices(entities, user_input, self.hass)})
        current = self.config_entry.options.get(CONF_SMOOTHING)
        return self.async_show_form(
            step_id="smoothing",
            data_schema=_smoothing_schema(entities, current if isinstance(current, dict) else None, self.hass),
        )
