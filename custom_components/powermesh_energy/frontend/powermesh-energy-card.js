const roles = [
  ["solar_power", "Solarleistung", "mdi:solar-power", "#b57912"],
  ["grid_import_power", "Netzbezug", "mdi:transmission-tower-import", "#22766d"],
  ["grid_export_power", "Einspeisung", "mdi:transmission-tower-export", "#b34f55"],
  ["battery_soc", "Akkustand", "mdi:battery", "#427a3b"],
];

export function sourceValue(state, role, now, staleMinutes = 15) {
  if (!state || ["unknown", "unavailable"].includes(state.state)) {
    return { value: null, status: "Nicht verfügbar" };
  }
  const unit = state.attributes?.unit_of_measurement;
  const percent = role === "battery_soc";
  if (!(percent ? unit === "%" : ["W", "kW"].includes(unit))) {
    return { value: null, status: "Einheit prüfen" };
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(state.state)) {
    return { value: null, status: "Wert ungültig" };
  }
  const numeric = Number(state.state);
  if (!Number.isFinite(numeric) || numeric < 0 || (percent && numeric > 100)) {
    return { value: null, status: percent ? "Akkustand prüfen" : "Richtung prüfen" };
  }
  const stamp = Date.parse(state.last_reported ?? state.last_updated);
  if (!Number.isFinite(stamp) || stamp > now + 60000) {
    return { value: null, status: "Zeitpunkt unklar" };
  }
  const age = Math.max(0, Math.floor((now - stamp) / 60000));
  const power = !percent && unit === "kW" ? numeric * 1000 : numeric;
  if (!Number.isFinite(power)) return { value: null, status: "Wert ungültig" };
  return {
    value: !percent && power >= 1000 ? power / 1000 : power,
    unit: percent ? "%" : power >= 1000 ? "kW" : "W",
    status: age >= staleMinutes ? `Veraltet · ${age} min` : age ? `Vor ${age} min` : "Gerade aktualisiert",
    stale: age >= staleMinutes,
  };
}

class PowermeshEnergyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; border-radius: var(--ha-card-border-radius, 8px); }
        header { display: flex; align-items: center; gap: 12px; padding: 20px 20px 12px; }
        header ha-icon { color: var(--primary-color); flex: none; }
        h2 { flex: 1; min-width: 0; margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0; overflow-wrap: anywhere; }
        .local { color: var(--secondary-text-color); font-size: 12px; }
        .values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 0 12px 12px; }
        .metric { font: inherit; color: var(--primary-text-color); text-align: left; background: transparent; border: 0; border-top: 1px solid var(--divider-color); padding: 16px 8px; min-width: 0; min-height: 144px; }
        button.metric { cursor: pointer; }
        button.metric:hover { background: var(--secondary-background-color); }
        button.metric:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
        .label { display: flex; align-items: center; gap: 6px; font-size: 14px; overflow-wrap: anywhere; }
        .label ha-icon { color: var(--metric-color); --mdc-icon-size: 20px; flex: none; }
        .number { display: block; font-size: 28px; font-weight: 600; line-height: 1.5; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
        .unit { font-size: 14px; font-weight: 400; padding-left: 5px; }
        .status { display: block; color: var(--secondary-text-color); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
        .stale .status { color: var(--warning-color, #b57912); }
        @media (prefers-reduced-motion: no-preference) { .metric { transition: background-color 120ms; } }
      </style>
      <ha-card><header><ha-icon icon="mdi:home-lightning-bolt-outline"></ha-icon><h2></h2><span class="local">Lokal</span></header><div class="values"></div></ha-card>`;
  }

  static getConfigElement() { return document.createElement("powermesh-energy-card-editor"); }

  static getStubConfig(hass) {
    const entity = Object.values(hass.states).find((state) => state.state === "local" && state.attributes?.roles)?.entity_id;
    return entity ? { entity } : {};
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Konfiguration fehlt");
    for (const key of ["entity", ...roles.map(([role]) => role)]) {
      if (config[key] != null && config[key] !== "" && (typeof config[key] !== "string" || !/^sensor\.[a-z0-9_]+$/.test(config[key]))) {
        throw new Error("Bitte Sensoren auswählen");
      }
    }
    if (config.title != null && (typeof config.title !== "string" || config.title.length > 120)) throw new Error("Titel ungültig");
    if (config.stale_after != null && (!Number.isInteger(config.stale_after) || config.stale_after < 1 || config.stale_after > 1440)) {
      throw new Error("Datenalter: 1 bis 1440 Minuten");
    }
    this._config = { ...config };
    this.render();
  }

  set hass(hass) { this._hass = hass; this.render(); }

  connectedCallback() {
    if (!this._timer) this._timer = window.setInterval(() => this.render(), 30000);
  }

  disconnectedCallback() { window.clearInterval(this._timer); this._timer = null; }

  getCardSize() { return 4; }

  render() {
    if (!this._config || !this._hass) return;
    const focusedRole = this.shadowRoot.activeElement?.dataset.role;
    this.shadowRoot.querySelector("h2").textContent = this._config.title || "Powermesh Energie";
    const configured = this._hass.states[this._config.entity]?.attributes?.roles || {};
    const children = roles.map(([role, label, icon, color]) => {
      const entity = this._config[role] || configured[role];
      const state = this._hass.states[entity];
      const result = entity ? sourceValue(state, role, Date.now(), this._config.stale_after ?? 15) : { value: null, status: "Nicht gewählt" };
      const metric = document.createElement(state ? "button" : "div");
      metric.dataset.role = role;
      metric.className = `metric${result.stale ? " stale" : ""}`;
      metric.style.setProperty("--metric-color", color);
      if (state) {
        metric.type = "button";
        metric.title = `${label}: ${state.attributes?.friendly_name || entity}`;
        metric.addEventListener("click", () => this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: entity }, bubbles: true, composed: true })));
      }
      const heading = document.createElement("span");
      heading.className = "label";
      const symbol = document.createElement("ha-icon");
      symbol.setAttribute("icon", icon);
      heading.append(symbol, document.createTextNode(label));
      const value = document.createElement("span");
      value.className = "number";
      value.textContent = result.value == null ? "–" : new Intl.NumberFormat(this._hass.locale?.language || "de", { maximumFractionDigits: result.unit === "kW" ? 2 : 0 }).format(result.value);
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = result.unit || "";
      value.append(unit);
      const status = document.createElement("span");
      status.className = "status";
      status.textContent = result.status;
      metric.append(heading, value, status);
      return metric;
    });
    this.shadowRoot.querySelector(".values").replaceChildren(...children);
    if (focusedRole) this.shadowRoot.querySelector(`button[data-role="${focusedRole}"]`)?.focus({ preventScroll: true });
  }
}

class PowermeshEnergyCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._form = document.createElement("ha-form");
    this._form.schema = [
      { name: "title", selector: { text: {} } },
      { name: "entity", selector: { entity: { domain: "sensor" } } },
      ...roles.map(([role]) => ({ name: role, selector: { entity: { domain: "sensor" } } })),
      { name: "stale_after", selector: { number: { min: 1, max: 1440, mode: "box", unit_of_measurement: "min" } } },
    ];
    this._form.computeLabel = ({ name }) => ({ title: "Titel", entity: "Lokale Energieübersicht", stale_after: "Veraltet nach" })[name] || roles.find(([role]) => role === name)?.[1] || name;
    this._form.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      this._config = { ...this._config, ...event.detail.value };
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
    });
    this.shadowRoot.append(this._form);
  }
  setConfig(config) { this._config = { ...config }; this._form.data = this._config; }
  set hass(hass) { this._form.hass = hass; }
}

if (!customElements.get("powermesh-energy-card")) customElements.define("powermesh-energy-card", PowermeshEnergyCard);
if (!customElements.get("powermesh-energy-card-editor")) customElements.define("powermesh-energy-card-editor", PowermeshEnergyCardEditor);

export function bandGeometry(value, low, high) {
  if (![low, high].every(Number.isFinite) || high < low) return null;
  const span = Math.max(high - low, Math.abs(high) * 0.01, 1e-6);
  let min = low - span * 0.5;
  let max = high + span * 0.5;
  const known = Number.isFinite(value);
  if (known) { min = Math.min(min, value); max = Math.max(max, value); }
  const pos = (x) => Math.round(((x - min) / (max - min)) * 1000) / 10;
  return {
    bandStart: pos(low),
    bandEnd: pos(high),
    marker: known ? pos(value) : null,
    outside: known && (value < low || value > high),
  };
}

const findingTexts = {
  deviation: "Außerhalb des Normalbereichs",
  counter_glitch: "Zählersprung (kurzzeitig gesunken)",
  counter_decrease: "Zählerstand gesunken",
  no_data: "Keine Werte",
};
const statusTexts = {
  ok: ["OK", "var(--success-color, #427a3b)"],
  learning: ["Lernt", "var(--info-color, #22766d)"],
  checking: ["Wird geprüft", "var(--warning-color, #b57912)"],
  problem: ["Auffällig", "var(--error-color, #b34f55)"],
  acknowledged: ["Bestätigt", "var(--secondary-text-color)"],
  no_data: ["Keine Werte", "var(--warning-color, #b57912)"],
  unsupported: ["Nicht unterstützt", "var(--secondary-text-color)"],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatTime(iso, language) {
  const stamp = Date.parse(iso);
  return Number.isFinite(stamp) ? new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(stamp) : "";
}

class PowermeshAnomalyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; }
        header { display: flex; align-items: center; gap: 12px; padding: 20px 20px 8px; }
        header ha-icon { color: var(--primary-color); flex: none; }
        h2 { flex: 1; min-width: 0; margin: 0; font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
        .count { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--secondary-background-color); }
        .count.alert { background: var(--error-color, #b34f55); color: var(--text-primary-color, #fff); }
        section { padding: 4px 16px 12px; }
        h3 { margin: 8px 0 4px; font-size: 14px; font-weight: 600; color: var(--secondary-text-color); }
        .finding, .monitor { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 10px 4px; border-top: 1px solid var(--divider-color); }
        .name { font-weight: 500; overflow-wrap: anywhere; }
        .meta { grid-column: 1 / -1; color: var(--secondary-text-color); font-size: 12px; overflow-wrap: anywhere; }
        .badge { font-size: 12px; align-self: start; color: var(--badge-color); }
        button { font: inherit; font-size: 13px; border-radius: 4px; border: 1px solid var(--primary-color); color: var(--primary-color); background: transparent; padding: 4px 10px; cursor: pointer; align-self: start; }
        button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .gauge { grid-column: 1 / -1; height: 14px; position: relative; border-radius: 7px; background: var(--secondary-background-color); }
        .band { position: absolute; top: 0; bottom: 0; border-radius: 7px; background: color-mix(in srgb, var(--success-color, #427a3b) 35%, transparent); }
        .marker { position: absolute; top: -2px; bottom: -2px; width: 3px; margin-left: -1px; border-radius: 2px; background: var(--primary-text-color); }
        .marker.outside { background: var(--error-color, #b34f55); }
        .empty { color: var(--secondary-text-color); font-size: 14px; padding: 8px 4px; }
        details summary { cursor: pointer; color: var(--secondary-text-color); font-size: 14px; padding: 8px 4px; }
      </style>
      <ha-card><header><ha-icon icon="mdi:alert-decagram-outline"></ha-icon><h2></h2><span class="count"></span></header><div class="body"></div></ha-card>`;
  }

  static getConfigElement() { return document.createElement("powermesh-anomaly-card-editor"); }

  static getStubConfig(hass) {
    const entity = Object.values(hass.states).find((state) => Array.isArray(state.attributes?.monitors) && Array.isArray(state.attributes?.findings))?.entity_id;
    return entity ? { entity } : {};
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Konfiguration fehlt");
    if (config.entity != null && config.entity !== "" && (typeof config.entity !== "string" || !/^sensor\.[a-z0-9_]+$/.test(config.entity))) {
      throw new Error("Bitte den Sensor „Offene Auffälligkeiten“ auswählen");
    }
    if (config.title != null && (typeof config.title !== "string" || config.title.length > 120)) throw new Error("Titel ungültig");
    this._config = { show_monitors: true, show_recent: true, ...config };
    this.render();
  }

  set hass(hass) { this._hass = hass; this.render(); }

  getCardSize() { return 5; }

  _acknowledge(findingId) {
    this._hass.callService("powermesh_energy", "acknowledge", { finding_id: findingId });
  }

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  _finding(finding, language) {
    const row = el("div", "finding");
    row.append(el("span", "name", finding.name || finding.entity_id));
    if (finding.acknowledged) {
      row.append(el("span", "badge", "Bestätigt"));
    } else {
      const button = el("button", null, "Bestätigen");
      button.type = "button";
      button.addEventListener("click", () => this._acknowledge(finding.id));
      row.append(button);
    }
    const parts = [findingTexts[finding.type] || finding.type, finding.area, `seit ${formatTime(finding.since, language)}`];
    if (finding.type === "deviation" && Number.isFinite(finding.band_low)) {
      parts.push(`Normal ${finding.band_low} – ${finding.band_high} ${finding.unit || ""}`.trim());
    }
    if (finding.resolved) parts.push(`beendet ${formatTime(finding.resolved, language)}`);
    row.append(el("span", "meta", parts.filter(Boolean).join(" · ")));
    return row;
  }

  _monitor(monitor, language) {
    const row = el("div", "monitor");
    const name = el("span", "name", monitor.name || monitor.entity_id);
    name.style.cursor = "pointer";
    name.addEventListener("click", () => this._moreInfo(monitor.entity_id));
    const [label, color] = statusTexts[monitor.status] || [monitor.status, "var(--secondary-text-color)"];
    const badge = el("span", "badge", label);
    badge.style.setProperty("--badge-color", color);
    row.append(name, badge);
    const state = this._hass.states[monitor.entity_id];
    const value = state && !["unknown", "unavailable"].includes(state.state) ? Number(state.state) : NaN;
    const parts = [monitor.area];
    if (Number.isFinite(value)) parts.push(`${new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value)} ${monitor.unit || ""}`.trim());
    if (monitor.status === "learning" && Number.isFinite(monitor.learning)) parts.push(`Lernfortschritt ${Math.round(monitor.learning * 100)} %`);
    if (monitor.kind === "counter") parts.push("Zählerprüfung");
    row.append(el("span", "meta", parts.filter(Boolean).join(" · ")));
    const geometry = monitor.kind === "baseline" ? bandGeometry(value, monitor.band_low, monitor.band_high) : null;
    if (geometry) {
      const gauge = el("div", "gauge");
      gauge.title = `Normalbereich ${monitor.band_low} – ${monitor.band_high} ${monitor.unit || ""}`.trim();
      const band = el("div", "band");
      band.style.left = `${geometry.bandStart}%`;
      band.style.width = `${geometry.bandEnd - geometry.bandStart}%`;
      gauge.append(band);
      if (geometry.marker != null) {
        const marker = el("div", `marker${geometry.outside ? " outside" : ""}`);
        marker.style.left = `${geometry.marker}%`;
        gauge.append(marker);
      }
      row.append(gauge);
    }
    return row;
  }

  render() {
    if (!this._config || !this._hass) return;
    const language = this._hass.locale?.language || "de";
    const state = this._hass.states[this._config.entity];
    const attributes = state?.attributes || {};
    this.shadowRoot.querySelector("h2").textContent = this._config.title || "Powermesh Auffälligkeiten";
    const active = Number(state?.state) || 0;
    const count = this.shadowRoot.querySelector(".count");
    count.textContent = state ? `${active} offen` : "";
    count.classList.toggle("alert", active > 0);
    const sections = [];
    if (!state) {
      sections.push(el("div", "empty", "Sensor „Offene Auffälligkeiten“ auswählen."));
    } else {
      const findings = el("section");
      findings.append(el("h3", null, "Auffälligkeiten"));
      const list = Array.isArray(attributes.findings) ? attributes.findings : [];
      if (list.length) list.forEach((finding) => findings.append(this._finding(finding, language)));
      else findings.append(el("div", "empty", "Keine offenen Auffälligkeiten."));
      sections.push(findings);
      const monitors = Array.isArray(attributes.monitors) ? attributes.monitors : [];
      if (this._config.show_monitors && monitors.length) {
        const section = el("section");
        section.append(el("h3", null, "Überwachte Sensoren"));
        monitors.forEach((monitor) => section.append(this._monitor(monitor, language)));
        sections.push(section);
      }
      const recent = Array.isArray(attributes.recent) ? attributes.recent : [];
      if (this._config.show_recent && recent.length) {
        const details = el("details");
        details.open = this._recentOpen === true;
        details.addEventListener("toggle", () => { this._recentOpen = details.open; });
        details.append(el("summary", null, `Zuletzt beendet (${recent.length})`));
        recent.forEach((finding) => details.append(this._finding({ ...finding, acknowledged: true }, language)));
        const section = el("section");
        section.append(details);
        sections.push(section);
      }
    }
    this.shadowRoot.querySelector(".body").replaceChildren(...sections);
  }
}

class PowermeshAnomalyCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._form = document.createElement("ha-form");
    this._form.schema = [
      { name: "title", selector: { text: {} } },
      { name: "entity", selector: { entity: { domain: "sensor", integration: "powermesh_energy" } } },
      { name: "show_monitors", selector: { boolean: {} } },
      { name: "show_recent", selector: { boolean: {} } },
    ];
    this._form.computeLabel = ({ name }) => ({ title: "Titel", entity: "Offene Auffälligkeiten", show_monitors: "Überwachte Sensoren zeigen", show_recent: "Beendete Auffälligkeiten zeigen" })[name] || name;
    this._form.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      this._config = { ...this._config, ...event.detail.value };
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
    });
    this.shadowRoot.append(this._form);
  }
  setConfig(config) { this._config = { show_monitors: true, show_recent: true, ...config }; this._form.data = this._config; }
  set hass(hass) { this._form.hass = hass; }
}

if (!customElements.get("powermesh-anomaly-card")) customElements.define("powermesh-anomaly-card", PowermeshAnomalyCard);
if (!customElements.get("powermesh-anomaly-card-editor")) customElements.define("powermesh-anomaly-card-editor", PowermeshAnomalyCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "powermesh-anomaly-card")) {
  window.customCards.push({ type: "powermesh-anomaly-card", name: "Powermesh Auffälligkeiten", description: "Lokale Auffälligkeiten und Normalbereiche", preview: true });
}
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "powermesh-energy-card")) {
  window.customCards.push({ type: "powermesh-energy-card", name: "Powermesh Energie", description: "Lokale Energieübersicht", preview: true });
}