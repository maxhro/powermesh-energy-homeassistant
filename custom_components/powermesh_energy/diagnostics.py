"""Diagnostics download for Powermesh Energie (API key redacted)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.const import CONF_API_KEY
from homeassistant.core import HomeAssistant

from . import PowermeshConfigEntry
from .const import CONF_MODE, MODE_LOCAL, MODE_MONITOR, VERSION
from .energy_dashboard import async_suggestion
from .monitor import AnomalyMonitor


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: PowermeshConfigEntry) -> dict[str, Any]:
    """Return configuration and upload state without secrets or reading values."""
    uploader = entry.runtime_data
    if isinstance(uploader, AnomalyMonitor):
        snapshot = uploader.snapshot
        statuses: dict[str, int] = {}
        for item in snapshot.get("monitors", []):
            statuses[item["status"]] = statuses.get(item["status"], 0) + 1
        findings: dict[str, int] = {}
        for item in snapshot.get("findings", []):
            findings[item["type"]] = findings.get(item["type"], 0) + 1
        # Counts only: no sensor values, names or entity IDs.
        return {
            "mode": MODE_MONITOR,
            "integration_version": VERSION,
            "monitors": len(uploader.entity_ids),
            "sensitivity": uploader.sensitivity,
            "monitor_status": statuses,
            "open_findings": findings,
            "recent_findings": len(snapshot.get("recent", [])),
        }
    if uploader is None and entry.data.get(CONF_MODE) != MODE_LOCAL:
        return {
            "mode": "cloud_disabled",
            "integration_version": VERSION,
            "entry": async_redact_data(dict(entry.data), {CONF_API_KEY}),
        }
    if uploader is None:
        return {"mode": "local", "integration_version": VERSION}
    suggestion, skipped = await async_suggestion(hass)
    return {
        "entry": async_redact_data(dict(entry.data), {CONF_API_KEY}),
        "options": dict(entry.options),
        "integration_version": VERSION,
        "latest_integration_version": uploader.latest_version,
        "server_release": uploader.server_release,
        "entities": uploader.entities,
        "upload_interval": uploader.interval_name,
        "smoothing": uploader.smoothing,
        "dashboard_suggestion": suggestion,
        "dashboard_skipped": skipped,
        "account_setup_required": uploader.account.setup_required if uploader.account else None,
        "account_setup_expires_at": uploader.account.setup_expires_at if uploader.account else None,
        "status": uploader.status,
        "last_error": uploader.last_error,
        "pending": uploader.pending,
        "accepted_total": uploader.accepted_total,
        "dropped_total": uploader.dropped_total,
        "buffer_limit_readings": uploader.buffer_limit,
        "last_upload": uploader.last_upload.isoformat() if uploader.last_upload else None,
    }
