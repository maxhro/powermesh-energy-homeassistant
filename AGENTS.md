# Powermesh Home Assistant Integration

## Current baseline

- Version `0.9.2` prototype: local anomaly monitoring (`monitor.py`,
  `monitor_flow.py`). Owner-confirmed sensors (max 50) suggested from areas,
  labels and devices: learned EWMA normal range for power/temperature/humidity,
  counter glitch/decrease checks for `total_increasing` energy, no-data checks,
  acknowledge service, persistent/notify-entity messages, findings sensor,
  problem binary sensor and `powermesh-anomaly-card`. Bounded learning state
  stays in private HA storage and is removed with the entry. No AI, no cloud,
  no control, no savings promises.
- The powermesh.de REST transfer is disabled via
  `const.CLOUD_TRANSFER_ENABLED = False`, not deleted. Cloud setup/options/reauth
  abort; existing cloud entries load without uploader, keep key and buffer and
  show a repair issue. Retained cloud tests enable the flag via the
  `cloud_transfer` fixture. When re-enabled it requires service API release
  `0.4.0`: selected numeric
  sensor readings, optional allowlisted Home Assistant metadata, smoothing and
  bounded offline buffering for powermesh.de.
  New website-paired cloud entries use an explicit snapshot mode: one current
  state per selected entity, coalesced locally and bounded to 200 entities;
  existing entries and operator-invitation fallback retain raw history mode.
  Snapshots are storage only, not a website display or analysis feature.
  Smart-home comparison and improvement potential are **in Entwicklung**,
  not implemented. Do not add analysis, exports, control or data sharing.
- Keep `manifest.json` and `const.py` versions aligned. Website, service and
  integration have independent version lifecycles. Interface documentation
  belongs in the private website/service repositories.
- Public documentation covers setup, sensor selection, status and privacy,
  never endpoints, headers, payload formats or error codes. State that
  powermesh.de terms apply. Do not publish credentials, archives, caches,
  virtual environments or test runtime data.
- Keep README screenshots in `docs/screenshots/` current with changed setup
  flows and dashboard cards; capture only synthetic, non-identifying data.
- Data is pseudonymous, not anonymous. Registration is not consent to sell or
  share household data. Retain explicit sensor selection, HTTPS/TLS, bounded
  buffering, confirmed-storage removal and visible loss/error reporting.
  Pending values must not be silently reassigned on a credential change.
  Do not reinterpret incompatible stored data or delete user data automatically.

## Setup paths and trust boundary

- Setup offers local anomaly monitoring and the local-only sensor overview.
  Only with the cloud flag enabled: an existing personal API key, the
  current website pairing flow, and a legacy operator-issued invitation.
  Pairing uses a one-use 22-character code and a random 256-bit installation
  secret stored privately in HA; the code expires after 30 minutes and is not an
  API key or proof of official HA software. Existing accounts are never attached.
- The website collects email/password, privacy/terms and separate storage
  consent. HA must never collect website passwords, email addresses, TOTP
  secrets/codes or consent on the website's behalf. Claim the API key only after
  website email verification and TOTP setup complete. Keep the pairing secret
  until successful claim for safe idempotent retries, then remove it. Never log
  the secret/code or auto-retry a claim in the background. Preserve buffered
  readings on key changes/removal.
- The server setup deadline is `HA_ACCOUNT_SETUP_DAYS` (default 7; operator
  range 1–365). Incomplete accounts are blocked at expiry and deleted by the
  hourly website maintenance job. The current website-pairing flow has no API
  key or upload buffer before setup and consent complete; do not invent auth errors.
- A registration response with a valid key but malformed account status keeps
  the key and shows a persistent protocol-error issue without a fabricated
  deadline until the service reports the account status.
- The current implementation is the project baseline. Describe current behavior
  and constraints, not implementation history or earlier project states.

## Checks

- Isolated Python environment: `pytest -q` and
  `python -m compileall -q custom_components`. Use synthetic data and mocked
  transport; never probe production or send real household data.
- Package checks: `node --test tests/package.test.mjs`.
- PowerShell 7: `pwsh -NoProfile -File ./build-package.ps1 -DryRun`;
  `-BuildPackage` creates a local manual-install ZIP without overwriting output.
  Packaging never publishes a release or connects to Home Assistant.
- Since Home Assistant 2026.11 HACS is built in as **Marketplace** (Settings →
  Marketplace, same catalog and `hacs.json`); document Marketplace first and
  HACS for 2026.10 and older.
- Marketplace/HACS (`hacs/action`) and hassfest jobs in
  `.github/workflows/validate.yml` are required before
  merge/release. A skipped or unavailable validator is not proof of acceptance.
  Keep private cross-project compatibility checks aligned.

## Operations

- Deployment, releases, pushes and live Home Assistant installation require
  separate authorization. A working service and matching website-issued key
  are prerequisites for installation acceptance, not assumptions.
- Controlled acceptance covers consent/access, sensor selection, smoothing,
  buffering, reconnect, deletion and diagnostics using synthetic data.
  Preserve user changes; stop owned test helpers and clean temporary files.
