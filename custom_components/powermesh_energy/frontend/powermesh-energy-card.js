if (typeof document !== "undefined") {
  await new Promise((resolve) => {
    const ready = () => {
      if (customElements.get("home-assistant") && customElements.get("ha-card")) resolve();
      else window.setTimeout(ready, 100);
    };
    ready();
  });
}

const roles = [
  ["solar_power", "Solarleistung", "mdi:solar-power", "#b57912"],
  ["grid_import_power", "Netzbezug", "mdi:transmission-tower-import", "#22766d"],
  ["grid_export_power", "Einspeisung", "mdi:transmission-tower-export", "#b34f55"],
  ["battery_soc", "Akkustand", "mdi:battery", "#427a3b"],
  ["consumer_power", "Leistungsverbraucher", "mdi:power-plug", "#5974a5"],
];

export function roleEntities(config, configured, role) {
  const explicit = config[role];
  const selected = explicit == null || explicit === "" || Array.isArray(explicit) && explicit.length === 0
    ? configured[role]
    : explicit;
  const entities = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : [];
  return [...new Set(entities.filter((entity) => typeof entity === "string" && /^sensor\.[a-z0-9_]+$/.test(entity)))];
}

export function configuredEnergyRoles(config, configured) {
  return roles.filter(([role]) => roleEntities(config, configured, role).length > 0);
}

const HISTORY_EXTRA_COLORS = ["#8856a7", "#077da8", "#d05b26", "#9f4679", "#697916", "#5348ad", "#9c5035", "#1c847e", "#ad4771", "#68717e"];
const HISTORY_HEX_COLOR = /^#[0-9a-f]{6}$/i;

function extraHistoryColor(index) {
  if (index < HISTORY_EXTRA_COLORS.length) return HISTORY_EXTRA_COLORS[index];
  const hue = (index * 137.508) % 360;
  return `#${[0, 8, 4].map((offset) => {
    const channel = (offset + hue / 30) % 12;
    return Math.round(255 * (0.46 - 0.28 * Math.max(-1, Math.min(channel - 3, 9 - channel, 1)))).toString(16).padStart(2, "0");
  }).join("")}`;
}

export function energyHistorySources(config, states) {
  const configured = states[config.entity]?.attributes?.roles || {};
  const sources = [];
  const add = (role, label, baseColor, entity, signedDirection) => {
    const name = states[entity]?.attributes?.friendly_name || entity;
    sources.push({ role, label: `${label}: ${name}`, baseColor, entity, signedDirection, key: `${role}:${entity}` });
  };
  for (const [role, label, , color] of roles) {
    if (role === "battery_soc" || config.grid_power_entity && ["grid_import_power", "grid_export_power"].includes(role)) continue;
    for (const entity of roleEntities(config, configured, role)) add(role, label, color, entity);
  }
  if (config.grid_power_entity) {
    const negativeIsExport = config.grid_negative_is_export ?? true;
    add("grid_import_power", "Netzbezug", "#22766d", config.grid_power_entity, negativeIsExport ? "positive" : "negative");
    add("grid_export_power", "Einspeisung", "#b34f55", config.grid_power_entity, negativeIsExport ? "negative" : "positive");
  }
  if (config.battery_power_entity) {
    const negativeIsDischarge = config.battery_negative_is_discharge ?? true;
    add("battery_charge_power", "Laden", "#427a3b", config.battery_power_entity, negativeIsDischarge ? "positive" : "negative");
    add("battery_discharge_power", "Entladen", "#8b5462", config.battery_power_entity, negativeIsDischarge ? "negative" : "positive");
  }
  const reserved = new Set(sources.map(({ baseColor }) => baseColor));
  const used = new Set();
  let extra = 0;
  return sources.map(({ baseColor, ...source }) => {
    let defaultColor = baseColor;
    if (used.has(defaultColor)) {
      do { defaultColor = extraHistoryColor(extra++); } while (used.has(defaultColor) || reserved.has(defaultColor));
    }
    used.add(defaultColor);
    return { ...source, defaultColor, color: config.history_colors?.[source.key] ?? defaultColor };
  });
}

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

export function signedPowerValue(state, negativeDirection, positiveDirection, negativeIsNegative, now, staleMinutes = 15) {
  if (!state || ["unknown", "unavailable"].includes(state.state)) {
    return { value: null, status: "Nicht verfügbar" };
  }
  const unit = state.attributes?.unit_of_measurement;
  if (!["W", "kW"].includes(unit)) return { value: null, status: "Einheit prüfen" };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(state.state)) {
    return { value: null, status: "Wert ungültig" };
  }
  const numeric = Number(state.state);
  if (!Number.isFinite(numeric)) return { value: null, status: "Wert ungültig" };
  const stamp = Date.parse(state.last_reported ?? state.last_updated);
  if (!Number.isFinite(stamp) || stamp > now + 60000) return { value: null, status: "Zeitpunkt unklar" };
  const age = Math.max(0, Math.floor((now - stamp) / 60000));
  const watts = Math.abs(numeric) * (unit === "kW" ? 1000 : 1);
  if (!Number.isFinite(watts)) return { value: null, status: "Wert ungültig" };
  const direction = numeric === 0
    ? "Ausgeglichen"
    : (numeric < 0) === negativeIsNegative ? negativeDirection : positiveDirection;
  const stale = age >= staleMinutes;
  return {
    value: watts >= 1000 ? watts / 1000 : watts,
    unit: watts >= 1000 ? "kW" : "W",
    direction,
    stale,
    status: `${direction}${stale ? ` · Veraltet · ${age} min` : age ? ` · Vor ${age} min` : " · Gerade aktualisiert"}`,
  };
}

export function summedSourceValue(states, role, now, staleMinutes = 15) {
  const results = states.map((state) => sourceValue(state, role, now, staleMinutes));
  const available = results.filter((result) => result.value != null);
  if (!results.length || available.length !== results.length) {
    return { value: null, status: `Quellen prüfen · ${available.length}/${results.length} verfügbar` };
  }
  const watts = available.reduce((total, result) => total + result.value * (result.unit === "kW" ? 1000 : 1), 0);
  if (!Number.isFinite(watts)) return { value: null, status: "Wert ungültig" };
  const stale = available.some((result) => result.stale);
  return {
    value: watts >= 1000 ? watts / 1000 : watts,
    unit: watts >= 1000 ? "kW" : "W",
    status: `${results.length} Quellen${stale ? " · mindestens eine veraltet" : ""}`,
    stale,
  };
}

export function averagedSourceValue(states, role, now, staleMinutes = 15) {
  const results = states.map((state) => sourceValue(state, role, now, staleMinutes));
  const available = results.filter((result) => result.value != null);
  if (!results.length || available.length !== results.length) {
    return { value: null, status: `Quellen prüfen · ${available.length}/${results.length} verfügbar` };
  }
  const value = available.reduce((total, result) => total + result.value, 0) / available.length;
  if (!Number.isFinite(value)) return { value: null, status: "Wert ungültig" };
  const stale = available.some((result) => result.stale);
  return {
    value,
    unit: "%",
    status: `Mittelwert aus ${results.length} Sensoren${stale ? " · mindestens einer veraltet" : ""}`,
    stale,
  };
}

const HISTORY_CHART_WIDTH = 360;
const HISTORY_CHART_HEIGHT = 156;
const HISTORY_CHART_STYLES = `
  .history-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 12px; margin: 0 0 8px; }
  .history-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .history-caption, .history-empty { color: var(--secondary-text-color); font-size: 12px; }
  .energy-chart { display: block; width: 100%; height: 156px; overflow: visible; }
  .energy-grid { stroke: var(--divider-color); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .energy-axis { fill: var(--secondary-text-color); font-size: 10px; }
  .energy-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .history-band { fill: var(--history-band-color); }
  .history-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 4px; }
  .history-legend-item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow-wrap: anywhere; color: var(--secondary-text-color); font-size: 12px; }
  .history-legend-swatch { width: 12px; height: 3px; flex: none; }
  @media (max-width: 480px) { .energy-chart { height: 140px; } }
`;

export class PowermeshEnergyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; border-radius: var(--ha-card-border-radius, 8px); }
        header { display: flex; align-items: center; gap: 12px; padding: 20px 20px 12px; }
        ha-card.no-header header { display: none; }
        ha-card.no-header .values { padding-top: 12px; }
        ha-card.no-header .metric { border-top: 0; }
        header ha-icon { color: var(--primary-color); flex: none; }
        h2 { flex: 1; min-width: 0; margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0; overflow-wrap: anywhere; }
        .local { color: var(--secondary-text-color); font-size: 12px; }
        .values { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); align-items: stretch; grid-auto-rows: minmax(144px, auto); padding: 0 12px 12px; }
        .metric { display: flex; flex-direction: column; align-items: flex-start; font: inherit; color: var(--primary-text-color); text-align: left; background: transparent; border: 0; border-top: 1px solid var(--divider-color); padding: 16px 8px; min-width: 0; width: 100%; min-height: 144px; box-sizing: border-box; }
        button.metric { cursor: pointer; }
        button.metric:hover { background: var(--secondary-background-color); }
        button.metric:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
        .label { display: flex; align-items: center; gap: 6px; font-size: 14px; overflow-wrap: anywhere; }
        .label ha-icon { color: var(--metric-color); --mdc-icon-size: 20px; flex: none; }
        .source-name { display: block; max-width: 100%; color: var(--secondary-text-color); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
        .number { display: block; font-size: 28px; font-weight: 600; line-height: 1.5; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
        .unit { font-size: 14px; font-weight: 400; padding-left: 5px; }
        .status { display: block; color: var(--secondary-text-color); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
        .stale .status { color: var(--warning-color, #b57912); }
        .history-section { border-top: 1px solid var(--divider-color); padding: 8px 20px 16px; }
        ${HISTORY_CHART_STYLES}
        @media (max-width: 480px) { .history-section { padding-inline: 12px; } }
        @media (prefers-reduced-motion: no-preference) { .metric { transition: background-color 120ms; } }
      </style>
      <ha-card><header><ha-icon icon="mdi:home-lightning-bolt-outline"></ha-icon><h2></h2><span class="local">Lokal</span></header><div class="values"></div><div class="history"></div></ha-card>`;
  }

  static getConfigElement() { return document.createElement("powermesh-energy-card-editor"); }

  static getStubConfig(hass) {
    const entity = Object.values(hass.states).find((state) => state.state === "local" && state.attributes?.roles)?.entity_id;
    return entity ? { entity, show_header: true } : { show_header: true };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Konfiguration fehlt");
    for (const key of ["entity", ...roles.map(([role]) => role)]) {
      const selected = config[key];
      const entities = typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected : selected == null || selected === "" ? [] : null;
      if (entities === null || entities.some((entity) => typeof entity !== "string" || !/^sensor\.[a-z0-9_]+$/.test(entity))) {
        throw new Error("Bitte Sensoren auswählen");
      }
    }
    for (const key of ["grid_power_entity", "battery_power_entity"]) {
      const entity = config[key];
      if (entity != null && entity !== "" && (typeof entity !== "string" || !/^sensor\.[a-z0-9_]+$/.test(entity))) {
        throw new Error("Bitte einen Leistungssensor auswählen");
      }
    }
    if (config.title != null && (typeof config.title !== "string" || config.title.length > 120)) throw new Error("Titel ungültig");
    if (config.stale_after != null && (!Number.isInteger(config.stale_after) || config.stale_after < 1 || config.stale_after > 1440)) {
      throw new Error("Datenalter: 1 bis 1440 Minuten");
    }
    if (config.history_hours != null && (!Number.isInteger(config.history_hours) || config.history_hours < 1 || config.history_hours > 48)) {
      throw new Error("Verlaufszeitraum: 1 bis 48 Stunden");
    }
    if (config.smoothing_minutes != null && (!Number.isInteger(config.smoothing_minutes) || config.smoothing_minutes < 0 || config.smoothing_minutes > 60)) {
      throw new Error("Glättung: 0 bis 60 Minuten");
    }
    if (config.history_colors != null && (typeof config.history_colors !== "object" || Array.isArray(config.history_colors)
      || Object.values(config.history_colors).some((color) => typeof color !== "string" || !HISTORY_HEX_COLOR.test(color)))) {
      throw new Error("Kurvenfarben: Bitte Hex-Farben im Format #RRGGBB verwenden");
    }
    this._config = { show_history: false, history_hours: 6, smoothing_minutes: 0, ...config };
    this.render();
  }

  set hass(hass) { this._hass = hass; this.render(); }

  connectedCallback() {
    if (!this._timer) this._timer = window.setInterval(() => this.render(), 30000);
  }

  disconnectedCallback() { window.clearInterval(this._timer); this._timer = null; }

  getCardSize() { return 4; }

  async _loadPowerHistory(sources) {
    const hours = this._config.history_hours;
    const entityIds = [...new Set(sources.map((item) => item.entity))].sort();
    const key = `${hours}|${entityIds.join(",")}`;
    if (this._historyLoading || (this._historyKey === key && Date.now() - this._historyAt < HISTORY_REFRESH_MS)) return;
    this._historyLoading = true;
    const end = Date.now();
    const start = end - hours * 3600000;
    try {
      const result = await this._hass.callWS({
        type: "history/history_during_period", start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(),
        entity_ids: entityIds, minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      this._powerHistory = { start: start / 1000, end: end / 1000, result };
    } catch {
      this._powerHistory = { error: true };
    } finally {
      this._historyKey = key;
      this._historyAt = Date.now();
      this._historyLoading = false;
      this.render();
    }
  }

  _renderPowerHistory(sources, language) {
    const section = el("section", "history-section");
    const smoothing = this._config.smoothing_minutes;
    section.append(historyHeading("Leistungsverlauf", this._config));
    if (!sources.length) {
      section.append(el("div", "history-empty", "Keine Leistungssensoren ausgewählt."));
      return section;
    }
    if (this._historyLoading || !this._powerHistory) {
      section.append(el("div", "history-empty", "Verlauf wird geladen …"));
      return section;
    }
    if (this._powerHistory.error) {
      section.append(el("div", "history-empty", "Verlauf nicht verfügbar."));
      return section;
    }
    const series = sources.map((source) => {
      const state = this._hass.states[source.entity];
      const unit = state?.attributes?.unit_of_measurement;
      const entries = Array.isArray(this._powerHistory.result?.[source.entity]) ? this._powerHistory.result[source.entity] : [];
      const points = entries.map((item) => {
        const rawValue = numericState(item.s ?? item.state);
        const value = source.signedDirection === "positive"
          ? rawValue >= 0 ? rawValue : NaN
          : source.signedDirection === "negative"
            ? rawValue < 0 ? Math.abs(rawValue) : NaN
            : rawValue;
        return [Number(item.lu ?? item.lc ?? Date.parse(item.last_updated ?? item.last_changed) / 1000), value >= 0 ? value : NaN];
      });
      return { ...source, unit, points };
    });
    const geometry = powerHistoryGeometry(series, this._powerHistory.start, this._powerHistory.end, HISTORY_CHART_WIDTH, HISTORY_CHART_HEIGHT, smoothing * 60, language);
    if (!geometry) {
      section.append(el("div", "history-empty", "Keine Werte im gewählten Zeitraum."));
      return section;
    }
    section.append(...renderHistoryChart(geometry, `Leistungsverlauf der letzten ${this._config.history_hours} Stunden`));
    return section;
  }

  render() {
    if (!this._config || !this._hass) return;
    const showHeader = Boolean(this._config.show_header ?? this._config.show_title ?? true);
    const cardEl = this.shadowRoot.querySelector("ha-card");
    if (cardEl) cardEl.classList.toggle("no-header", !showHeader);
    const focusedRole = this.shadowRoot.activeElement?.dataset.key;
    this.shadowRoot.querySelector("h2").textContent = this._config.title || "Powermesh Energie";
    const configured = this._hass.states[this._config.entity]?.attributes?.roles || {};
    const combinedGrid = Boolean(this._config.grid_power_entity);
    const sources = this._config.show_history
      ? energyHistorySources(this._config, this._hass.states).filter(({ entity }) => this._hass.states[entity])
      : [];
    if (this._config.show_history && sources.length) this._loadPowerHistory(sources);
    const children = configuredEnergyRoles(this._config, configured)
      .filter(([role]) => !(combinedGrid && ["grid_import_power", "grid_export_power"].includes(role)))
      .flatMap(([role, label, icon, color]) => {
      const entities = roleEntities(this._config, configured, role);
      const grouped = this._config.sum_by_area && role !== "battery_soc" || this._config.average_battery_soc && role === "battery_soc";
      const aggregationLabel = role === "battery_soc" ? "Mittelwert" : "Summe";
      const aggregate = role === "battery_soc" ? averagedSourceValue : summedSourceValue;
      const groups = grouped ? [[null, aggregate(entities.map((entity) => this._hass.states[entity]), role, Date.now(), this._config.stale_after ?? 15)]] : entities.map((entity) => [entity, sourceValue(this._hass.states[entity], role, Date.now(), this._config.stale_after ?? 15)]);
      return groups.map(([entity, result], index) => {
      const state = entity ? this._hass.states[entity] : null;
      const metric = document.createElement(state ? "button" : "div");
      const key = entity || `${role}:sum`;
      metric.dataset.key = key;
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
      heading.append(symbol, document.createTextNode(grouped ? `${label} · ${aggregationLabel}` : label));
      const sourceName = document.createElement("span");
      sourceName.className = "source-name";
      sourceName.textContent = grouped ? `${entities.length} Sensoren` : state?.attributes?.friendly_name || entity;
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
      metric.append(heading, sourceName, value, status);
      return metric;
      });
    });
    const signedMetric = ({ entity, key, label, icon, color, negativeDirection, positiveDirection, negativeIsNegative }) => {
      const state = this._hass.states[entity];
      const result = state
        ? signedPowerValue(state, negativeDirection, positiveDirection, negativeIsNegative, Date.now(), this._config.stale_after ?? 15)
        : { value: null, status: "Nicht verfügbar" };
      const metric = document.createElement(state ? "button" : "div");
      metric.dataset.key = key;
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
      const sourceName = document.createElement("span");
      sourceName.className = "source-name";
      sourceName.textContent = state?.attributes?.friendly_name || entity;
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
      metric.append(heading, sourceName, value, status);
      return metric;
    };
    if (this._config.grid_power_entity) {
      children.push(signedMetric({
        entity: this._config.grid_power_entity,
        key: "grid_power_entity",
        label: "Kombinierter Netzfluss",
        icon: "mdi:transmission-tower",
        color: "#22766d",
        negativeDirection: "Einspeisung",
        positiveDirection: "Netzbezug",
        negativeIsNegative: this._config.grid_negative_is_export ?? true,
      }));
    }
    if (this._config.battery_power_entity) {
      children.push(signedMetric({
        entity: this._config.battery_power_entity,
        key: "battery_power_entity",
        label: "Batterieleistung",
        icon: "mdi:battery-charging",
        color: "#5974a5",
        negativeDirection: "Entladen",
        positiveDirection: "Laden",
        negativeIsNegative: this._config.battery_negative_is_discharge ?? true,
      }));
    }
    this.shadowRoot.querySelector(".values").replaceChildren(...children);
    const history = this.shadowRoot.querySelector(".history");
    history.replaceChildren();
    if (this._config.show_history) history.append(this._renderPowerHistory(sources, this._hass.locale?.language || "de"));
    if (focusedRole) [...this.shadowRoot.querySelectorAll("button.metric")].find((metric) => metric.dataset.key === focusedRole)?.focus({ preventScroll: true });
  }
}

export class PowermeshEnergyCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._form = document.createElement("ha-form");
    this._form.schema = [
      { name: "title", selector: { text: {} } },
      { name: "show_header", selector: { boolean: {} } },
      { name: "entity", selector: { entity: { domain: "sensor", integration: "powermesh_energy" } } },
      ...roles.map(([role]) => ({
        name: role,
        selector: {
          entity: {
            multiple: true,
            filter: [{
              domain: "sensor",
              device_class: role === "battery_soc" ? ["battery"] : ["power"],
              unit_of_measurement: role === "battery_soc" ? ["%"] : ["W", "kW"],
            }],
          },
        },
      })),
      ...["grid_power_entity", "battery_power_entity"].map((name) => ({
        name,
        selector: {
          entity: {
            filter: [{ domain: "sensor", device_class: ["power"], unit_of_measurement: ["W", "kW"] }],
          },
        },
      })),
      { name: "stale_after", selector: { number: { min: 1, max: 1440, mode: "box", unit_of_measurement: "min" } } },
      { name: "sum_by_area", selector: { boolean: {} } },
      { name: "average_battery_soc", selector: { boolean: {} } },
      { name: "grid_negative_is_export", selector: { boolean: {} } },
      { name: "battery_negative_is_discharge", selector: { boolean: {} } },
      { name: "show_history", selector: { boolean: {} } },
      { name: "history_hours", selector: { number: { min: 1, max: 48, mode: "box", unit_of_measurement: "h" } } },
      { name: "smoothing_minutes", selector: { number: { min: 0, max: 60, mode: "box", unit_of_measurement: "min" } } },
    ];
    this._form.computeLabel = ({ name }) => ({
      title: "Titel", show_header: "Kopfbereich mit Titel anzeigen", entity: "Lokale Energieübersicht", stale_after: "Veraltet nach", sum_by_area: "Leistung je Bereich summieren", average_battery_soc: "Akkustände mitteln",
      grid_power_entity: "Kombinierter Netzsensor (ersetzt getrennte Sensoren)", grid_negative_is_export: "Negative Netzwerte bedeuten Einspeisung",
      battery_power_entity: "Batterieleistung (Laden/Entladen)", battery_negative_is_discharge: "Negative Batteriewerte bedeuten Entladen",
      show_history: "Leistungsverlauf anzeigen", history_hours: "Verlaufszeitraum", smoothing_minutes: "Glättung (0 = aus)",
    })[name] || roles.find(([role]) => role === name)?.[1] || name;
    this._form.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      this._config = { ...this._config, ...event.detail.value };
      this._renderHistoryColors();
      this._emitConfig();
    });
    this._colorFields = el("fieldset");
    this._colorFields.hidden = true;
    this._colorRows = el("div");
    this._colorFields.append(el("legend", null, "Kurvenfarben"), this._colorRows);
    const style = el("style", null, `
      fieldset { margin: 16px 0 0; min-width: 0; border: 1px solid var(--divider-color); border-radius: 6px; }
      .color-row { display: grid; grid-template-columns: minmax(0, 1fr) 44px 36px; align-items: center; gap: 8px; min-height: 44px; }
      label { overflow-wrap: anywhere; cursor: pointer; }
      input { width: 44px; height: 36px; padding: 2px; box-sizing: border-box; cursor: pointer; }
      button { display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 4px; background: transparent; color: var(--primary-text-color); cursor: pointer; }
      button:not(:disabled):hover { background: var(--secondary-background-color); }
      button:disabled { opacity: 0.35; cursor: default; }
      button:focus-visible, input:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    `);
    this.shadowRoot.append(style, this._form, this._colorFields);
  }
  setConfig(config) {
    const rolesConfig = Object.fromEntries(roles.flatMap(([role]) => {
      const selected = config[role];
      return selected == null ? [] : [[role, typeof selected === "string" ? [selected] : selected]];
    }));
    this._config = { show_header: true, show_history: false, history_hours: 6, smoothing_minutes: 0, sum_by_area: false, average_battery_soc: false, grid_negative_is_export: true, battery_negative_is_discharge: true, ...config, ...rolesConfig };
    this._form.data = this._config;
    this._renderHistoryColors();
  }

  set hass(hass) {
    this._hass = hass;
    this._form.hass = hass;
    this._renderHistoryColors();
  }

  _emitConfig() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  _setHistoryColor(key, color) {
    const colors = { ...this._config.history_colors };
    if (color == null) delete colors[key];
    else colors[key] = color;
    const { history_colors, ...config } = this._config;
    this._config = Object.keys(colors).length ? { ...config, history_colors: colors } : config;
    this._form.data = this._config;
    this._renderHistoryColors();
    this._emitConfig();
  }

  _renderHistoryColors() {
    const sources = this._config?.show_history ? energyHistorySources(this._config, this._hass?.states || {}) : [];
    this._colorFields.hidden = !sources.length;
    const signature = JSON.stringify(sources.map(({ key, label }) => [key, label]));
    if (this._colorRowsSignature !== signature) {
      this._colorRowsSignature = signature;
      this._colorInputs = sources.map(({ key, label }, index) => {
        const row = el("div", "color-row");
        const input = el("input");
        input.type = "color";
        input.id = `history-color-${index}`;
        input.addEventListener("change", () => this._setHistoryColor(key, input.value));
        const fieldLabel = el("label", null, label);
        fieldLabel.htmlFor = input.id;
        const reset = el("button");
        reset.type = "button";
        reset.title = "Standardfarbe wiederherstellen";
        reset.setAttribute("aria-label", `${reset.title}: ${label}`);
        const icon = el("ha-icon");
        icon.setAttribute("icon", "mdi:restore");
        reset.append(icon);
        reset.addEventListener("click", () => { input.focus(); this._setHistoryColor(key, null); });
        row.append(fieldLabel, input, reset);
        return { row, input, reset };
      });
      this._colorRows.replaceChildren(...this._colorInputs.map(({ row }) => row));
    }
    sources.forEach(({ key, color, defaultColor }, index) => {
      const { input, reset } = this._colorInputs[index];
      const value = typeof color === "string" && HISTORY_HEX_COLOR.test(color) ? color.toLowerCase() : defaultColor;
      if (input.value !== value) input.value = value;
      reset.disabled = !Object.hasOwn(this._config.history_colors || {}, key);
    });
  }
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

const round1 = (value) => Math.round(value * 10) / 10;

export function numericState(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  return typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : NaN;
}

export function smoothHistory(points, windowSeconds) {
  const ordered = points.filter(([time]) => Number.isFinite(time)).slice().sort(([left], [right]) => left - right);
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return ordered;
  let segments = [];
  let head = 0;
  let weighted = 0;
  let covered = 0;
  let previous;
  return ordered.map(([time, value]) => {
    if (!Number.isFinite(value)) {
      segments = [];
      head = weighted = covered = 0;
      previous = undefined;
      return [time, NaN];
    }
    if (previous && time > previous[0]) {
      segments.push({ start: previous[0], end: time, value: previous[1] });
      weighted += previous[1] * (time - previous[0]);
      covered += time - previous[0];
    }
    const cutoff = time - windowSeconds;
    while (head < segments.length && segments[head].end <= cutoff) {
      const segment = segments[head++];
      weighted -= segment.value * (segment.end - segment.start);
      covered -= segment.end - segment.start;
    }
    if (head < segments.length && segments[head].start < cutoff) {
      const segment = segments[head];
      weighted -= segment.value * (cutoff - segment.start);
      covered -= cutoff - segment.start;
      segment.start = cutoff;
    }
    previous = [time, value];
    return [time, covered > 0 ? weighted / covered : value];
  });
}

export function powerHistoryGeometry(series, start, end, width, height, smoothingSeconds = 0, language) {
  const watts = series.filter(({ unit }) => unit === "W" || unit === "kW").map((item) => ({
    ...item, points: item.points.map(([time, value]) => [time, value >= 0 ? value * (item.unit === "kW" ? 1000 : 1) : NaN]),
  }));
  return historyGeometry(watts, start, end, width, height, smoothingSeconds, language, { power: true });
}

export function historyGeometry(series, start, end, width, height, smoothingSeconds = 0, language, { power = false, band } = {}) {
  if (!(end > start) || !series.length) return null;
  const right = width - 8;
  const top = 8;
  const bottom = height - 24;
  const plotHeight = bottom - top;
  const normalized = series.map((item) => {
    const smoothed = smoothHistory(item.points.filter(([time]) => time <= end), smoothingSeconds);
    const visible = smoothed.filter(([time]) => time >= start);
    const previous = smoothed.findLast(([time]) => time < start);
    if (previous && (!visible.length || visible[0][0] > start)) visible.unshift([start, previous[1]]);
    return { ...item, points: visible };
  }).filter((item) => item.points.some(([, value]) => Number.isFinite(value)));
  if (!normalized.length) return null;
  const hasBand = band?.every(Number.isFinite) && band[1] >= band[0];
  let minValue = power ? 0 : hasBand ? band[0] : Infinity;
  let maxValue = power ? 0 : hasBand ? band[1] : -Infinity;
  for (const item of normalized) {
    for (const [, value] of item.points) {
      if (!Number.isFinite(value)) continue;
      minValue = Math.min(minValue, value);
      maxValue = Math.max(maxValue, value);
    }
  }
  if (power) {
    const roughStep = (maxValue || 1) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const fraction = roughStep / magnitude;
    const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
    maxValue = Math.max(step, Math.ceil(maxValue / step) * step);
  } else {
    const pad = (maxValue - minValue) * 0.05 || Math.max(Math.abs(minValue) * 0.01, 1e-6);
    minValue -= pad;
    maxValue += pad;
  }
  const span = maxValue - minValue;
  const formatValue = new Intl.NumberFormat(language, {
    maximumFractionDigits: power ? 1 : Math.max(0, Math.min(20, 1 - Math.floor(Math.log10(span / 4)))),
  });
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = minValue + span * (4 - index) / 4;
    const kilowatts = power && value >= 1000;
    return { y: round1(top + plotHeight * index / 4), label: formatValue.format(kilowatts ? value / 1000 : value), unit: power ? kilowatts ? "kW" : "W" : normalized[0].unit };
  });
  const left = Math.max(42, Math.min(width / 3, Math.max(...grid.map(({ label, unit }) => `${label} ${unit || ""}`.length)) * 6 + 8));
  const plotWidth = right - left;
  const x = (time) => round1(left + Math.min(1, Math.max(0, (time - start) / (end - start))) * plotWidth);
  const y = (value) => round1(bottom - Math.min(1, Math.max(0, (value - minValue) / span)) * plotHeight);
  const ticks = [0, 0.5, 1].map((fraction) => {
    const time = start + (end - start) * fraction;
    return { x: round1(left + plotWidth * fraction), label: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(time * 1000) };
  });
  const lines = normalized.map((item) => {
    const path = [];
    let open = false;
    for (const [time, value] of item.points) {
      if (!Number.isFinite(value)) {
        if (open) path.push(`H${x(time)}`);
        open = false;
      } else if (!open) {
        path.push(`M${x(time)} ${y(value)}`);
        open = true;
      } else {
        path.push(`H${x(time)} V${y(value)}`);
      }
    }
    if (open) path.push(`H${right}`);
    return { role: item.role, label: item.label, color: item.color, path: path.join(" ") };
  }).filter((item) => item.path);
  return { left, right, top, bottom, grid, ticks, lines, maxValue, bandTop: hasBand ? y(band[1]) : null, bandBottom: hasBand ? y(band[0]) : null };
}

function historyHeading(title, config) {
  const heading = el("div", "history-heading");
  const smoothing = config.smoothing_minutes;
  const caption = `Letzte ${config.history_hours} h${smoothing ? ` · geglättet ${smoothing} min` : ""}`;
  heading.append(el("h3", null, title), el("span", "history-caption", caption));
  return heading;
}

function renderHistoryChart(geometry, description) {
  const chart = svg("svg", { class: "energy-chart", viewBox: `0 0 ${HISTORY_CHART_WIDTH} ${HISTORY_CHART_HEIGHT}`, preserveAspectRatio: "none", role: "img", "aria-label": description });
  const legend = el("div", "history-legend");
  const addLegendItem = (label, color) => {
    const item = el("span", "history-legend-item");
    const swatch = el("span", "history-legend-swatch");
    swatch.style.backgroundColor = color;
    item.append(swatch, el("span", null, label));
    legend.append(item);
  };
  if (geometry.bandTop != null) {
    chart.append(svg("rect", { class: "history-band", x: geometry.left, y: geometry.bandTop, width: geometry.right - geometry.left, height: Math.max(0.5, geometry.bandBottom - geometry.bandTop) }));
  }
  geometry.grid.forEach((line) => {
    chart.append(svg("line", { class: "energy-grid", x1: geometry.left, x2: geometry.right, y1: line.y, y2: line.y }));
    const label = svg("text", { class: "energy-axis", x: geometry.left - 5, y: line.y + 3, "text-anchor": "end" });
    label.textContent = line.unit ? `${line.label} ${line.unit}` : line.label;
    chart.append(label);
  });
  geometry.ticks.forEach((tick) => {
    chart.append(svg("line", { class: "energy-grid", x1: tick.x, x2: tick.x, y1: geometry.top, y2: geometry.bottom, opacity: 0.45 }));
    const label = svg("text", { class: "energy-axis", x: tick.x, y: HISTORY_CHART_HEIGHT - 5, "text-anchor": tick.x === geometry.left ? "start" : tick.x === geometry.right ? "end" : "middle" });
    label.textContent = tick.label;
    chart.append(label);
  });
  geometry.lines.forEach((line) => {
    chart.append(svg("path", { class: "energy-line", d: line.path, stroke: line.color }));
    addLegendItem(line.label, line.color);
  });
  if (geometry.bandTop != null) addLegendItem("Normalbereich", "var(--history-band-color)");
  return [chart, legend];
}

/** Horizontal timeline segments in percent of the window; open findings last until `end`. */
export function timelineSegments(findings, start, end) {
  if (!(end > start)) return [];
  return findings.flatMap((finding) => {
    const from = Date.parse(finding.since) / 1000;
    const to = finding.resolved ? Date.parse(finding.resolved) / 1000 : end;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < start || from > end) return [];
    const left = Math.max(0, (Math.max(from, start) - start) / (end - start)) * 100;
    const right = Math.min(1, (Math.min(to, end) - start) / (end - start)) * 100;
    return [{ left: round1(left), width: round1(Math.max(0.5, right - left)), type: finding.type, category: finding.category, open: !finding.resolved }];
  });
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

function svg(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

const ANOMALY_DEFAULTS = { show_header: true, show_monitors: true, show_recent: true, show_history: false, history_hours: 6, smoothing_minutes: 5, show_learning_bar: false, show_timeline: false, timeline_days: 7 };
const HISTORY_REFRESH_MS = 300000;

function formatTime(iso, language) {
  const stamp = Date.parse(iso);
  return Number.isFinite(stamp) ? new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(stamp) : "";
}

export class PowermeshAnomalyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; }
        header { display: flex; align-items: center; gap: 12px; padding: 20px 20px 8px; }
        ha-card.no-header header { display: none; }
        ha-card.no-header .body { padding-top: 12px; }
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
        .progress { grid-column: 1 / -1; height: 6px; border-radius: 3px; background: var(--secondary-background-color); overflow: hidden; }
        .progress > div { height: 100%; background: var(--info-color, #22766d); }
        .monitor-history { grid-column: 1 / -1; min-width: 0; margin-top: 8px; --history-band-color: color-mix(in srgb, var(--success-color, #427a3b) 30%, transparent); }
        ${HISTORY_CHART_STYLES}
        .timeline { position: relative; height: 18px; margin: 4px 4px 2px; border-radius: 4px; background: var(--secondary-background-color); }
        .timeline span { position: absolute; top: 3px; bottom: 3px; border-radius: 3px; background: var(--error-color, #b34f55); }
        .timeline span.data_quality { background: var(--warning-color, #b57912); }
        .timeline span.done { opacity: 0.55; }
        .timeline-axis { display: flex; justify-content: space-between; color: var(--secondary-text-color); font-size: 11px; padding: 0 4px 4px; }
        .legend { display: flex; flex-wrap: wrap; gap: 12px; color: var(--secondary-text-color); font-size: 11px; padding: 0 4px; }
        .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; background: var(--error-color, #b34f55); }
        .legend i.data_quality { background: var(--warning-color, #b57912); }
      </style>
      <ha-card><header><ha-icon icon="mdi:alert-decagram-outline"></ha-icon><h2></h2><span class="count"></span></header><div class="body"></div></ha-card>`;
  }

  static getConfigElement() { return document.createElement("powermesh-anomaly-card-editor"); }

  static getStubConfig(hass) {
    const entity = Object.values(hass.states).find((state) => Array.isArray(state.attributes?.monitors) && Array.isArray(state.attributes?.findings))?.entity_id;
    return entity ? { entity, show_header: true } : { show_header: true };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Konfiguration fehlt");
    if (config.entity != null && config.entity !== "" && (typeof config.entity !== "string" || !/^sensor\.[a-z0-9_]+$/.test(config.entity))) {
      throw new Error("Bitte den Sensor „Offene Auffälligkeiten“ auswählen");
    }
    if (config.title != null && (typeof config.title !== "string" || config.title.length > 120)) throw new Error("Titel ungültig");
    if (config.history_hours != null && (!Number.isInteger(config.history_hours) || config.history_hours < 1 || config.history_hours > 48)) {
      throw new Error("Verlauf: 1 bis 48 Stunden");
    }
    if (config.smoothing_minutes != null && (!Number.isInteger(config.smoothing_minutes) || config.smoothing_minutes < 0 || config.smoothing_minutes > 60)) {
      throw new Error("Glättung: 0 bis 60 Minuten");
    }
    if (config.timeline_days != null && (!Number.isInteger(config.timeline_days) || config.timeline_days < 1 || config.timeline_days > 30)) {
      throw new Error("Zeitleiste: 1 bis 30 Tage");
    }
    this._config = { ...ANOMALY_DEFAULTS, ...config };
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

  async _loadHistory(entityIds) {
    const hours = this._config.history_hours;
    const key = `${hours}|${entityIds.join(",")}`;
    if (this._historyLoading || (this._historyKey === key && Date.now() - this._historyAt < HISTORY_REFRESH_MS)) return;
    this._historyLoading = true;
    const end = Date.now();
    const start = end - hours * 3600000;
    try {
      // Reads Home Assistant's own recorder history; nothing is stored or sent elsewhere.
      const result = await this._hass.callWS({
        type: "history/history_during_period", start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(),
        entity_ids: entityIds, minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      const series = {};
      for (const id of entityIds) {
        series[id] = (Array.isArray(result?.[id]) ? result[id] : []).map((item) => [
          Number(item.lu ?? item.lc ?? Date.parse(item.last_updated ?? item.last_changed) / 1000),
          numericState(item.s ?? item.state),
        ]);
      }
      this._history = { start: start / 1000, end: end / 1000, series };
    } catch {
      this._history = { error: true };
    } finally {
      this._historyKey = key;
      this._historyAt = Date.now();
      this._historyLoading = false;
      this.render();
    }
  }

  _renderMonitorHistory(monitor, language) {
    const container = el("div", "monitor-history");
    container.append(historyHeading("Verlauf", this._config));
    const message = (text) => {
      container.append(el("div", "history-empty", text));
      return container;
    };
    const history = this._history;
    if (!history || this._historyKey?.split("|")[1]?.split(",").includes(monitor.entity_id) !== true) {
      return message("Verlauf wird geladen …");
    }
    if (history.error) return message("Verlauf nicht verfügbar.");
    const label = monitor.name || monitor.entity_id;
    const series = [{ label, unit: monitor.unit, color: "var(--primary-color)", points: history.series[monitor.entity_id] || [] }];
    const band = monitor.kind === "baseline" ? [monitor.band_low, monitor.band_high] : undefined;
    const geometry = historyGeometry(series, history.start, history.end, HISTORY_CHART_WIDTH, HISTORY_CHART_HEIGHT, this._config.smoothing_minutes * 60, language, { band });
    if (!geometry) return message("Keine Werte im Zeitraum.");
    container.append(...renderHistoryChart(geometry, `Verlauf: ${label}${geometry.bandTop != null ? " mit Normalbereich" : ""}`));
    return container;
  }

  _timeline(findings, language) {
    const end = Date.now() / 1000;
    const start = end - this._config.timeline_days * 86400;
    const section = el("section");
    section.append(el("h3", null, `Zeitleiste (${this._config.timeline_days} Tage)`));
    const bar = el("div", "timeline");
    bar.setAttribute("role", "img");
    const segments = timelineSegments(findings, start, end);
    bar.setAttribute("aria-label", `${segments.length} Auffälligkeiten im Zeitraum`);
    findings.forEach((finding) => {
      const [segment] = timelineSegments([finding], start, end);
      if (!segment) return;
      const span = el("span", `${segment.category === "data_quality" ? "data_quality" : "behavior"}${segment.open ? "" : " done"}`);
      span.style.left = `${segment.left}%`;
      span.style.width = `${segment.width}%`;
      span.title = `${finding.name || finding.entity_id}: ${findingTexts[finding.type] || finding.type}, ${formatTime(finding.since, language)}`;
      bar.append(span);
    });
    const axis = el("div", "timeline-axis");
    const date = (seconds) => new Intl.DateTimeFormat(language, { dateStyle: "short" }).format(seconds * 1000);
    axis.append(el("span", null, date(start)), el("span", null, "jetzt"));
    const legend = el("div", "legend");
    const item = (category, text) => { const entry = el("span"); entry.append(el("i", category), document.createTextNode(text)); return entry; };
    legend.append(item("behavior", "Verhalten"), item("data_quality", "Datenqualität"), el("span", null, "blass = beendet"));
    section.append(bar, axis, legend);
    return section;
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
    if (this._config.show_learning_bar && monitor.status === "learning" && Number.isFinite(monitor.learning)) {
      const progress = el("div", "progress");
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      progress.setAttribute("aria-valuenow", String(Math.round(monitor.learning * 100)));
      progress.setAttribute("aria-label", "Lernfortschritt");
      const fill = el("div");
      fill.style.width = `${Math.min(100, Math.max(0, monitor.learning * 100))}%`;
      progress.append(fill);
      row.append(progress);
    }
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
    if (this._config.show_history) row.append(this._renderMonitorHistory(monitor, language));
    return row;
  }

  render() {
    if (!this._config || !this._hass) return;
    const showHeader = Boolean(this._config.show_header ?? this._config.show_title ?? true);
    const cardEl = this.shadowRoot.querySelector("ha-card");
    if (cardEl) cardEl.classList.toggle("no-header", !showHeader);
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
      if (this._config.show_monitors && this._config.show_history && monitors.length) {
        this._loadHistory(monitors.map((monitor) => monitor.entity_id).filter((id) => /^sensor\.[a-z0-9_]+$/.test(id)).sort());
      }
      if (this._config.show_monitors && monitors.length) {
        const section = el("section");
        section.append(el("h3", null, "Überwachte Sensoren"));
        monitors.forEach((monitor) => section.append(this._monitor(monitor, language)));
        sections.push(section);
      }
      const recent = Array.isArray(attributes.recent) ? attributes.recent : [];
      if (this._config.show_timeline) sections.push(this._timeline([...list, ...recent], language));
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
      { name: "show_header", selector: { boolean: {} } },
      { name: "entity", selector: { entity: { domain: "sensor", integration: "powermesh_energy" } } },
      { name: "show_monitors", selector: { boolean: {} } },
      { name: "show_recent", selector: { boolean: {} } },
      { name: "show_learning_bar", selector: { boolean: {} } },
      { name: "show_history", selector: { boolean: {} } },
      { name: "history_hours", selector: { number: { min: 1, max: 48, mode: "box", unit_of_measurement: "h" } } },
      { name: "smoothing_minutes", selector: { number: { min: 0, max: 60, mode: "box", unit_of_measurement: "min" } } },
      { name: "show_timeline", selector: { boolean: {} } },
      { name: "timeline_days", selector: { number: { min: 1, max: 30, mode: "box", unit_of_measurement: "d" } } },
    ];
    this._form.computeLabel = ({ name }) => ({
      title: "Titel", show_header: "Kopfbereich mit Titel anzeigen", entity: "Offene Auffälligkeiten", show_monitors: "Überwachte Sensoren zeigen", show_recent: "Beendete Auffälligkeiten zeigen",
      show_learning_bar: "Lernfortschritt als Balken", show_history: "Verlaufsdiagramm mit Normalbereich", history_hours: "Verlaufszeitraum", smoothing_minutes: "Glättung (0 = aus)",
      show_timeline: "Zeitleiste der Auffälligkeiten", timeline_days: "Zeitleistenzeitraum",
    })[name] || name;
    this._form.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      this._config = { ...this._config, ...event.detail.value };
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
    });
    this.shadowRoot.append(this._form);
  }
  setConfig(config) { this._config = { ...ANOMALY_DEFAULTS, ...config }; this._form.data = this._config; }
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


export const VFD_SEGMENTS = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "d", "e", "g"],
  "3": ["a", "b", "c", "d", "g"],
  "4": ["b", "c", "f", "g"],
  "5": ["a", "c", "d", "f", "g"],
  "6": ["a", "c", "d", "e", "f", "g"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
  "-": ["g"],
};

export function formatMeterDigits(value, decimals = 1, minIntegerDigits = 6) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  const clampedDec = Math.max(0, Math.min(3, Math.round(Number(decimals) || 0)));
  const factor = 10 ** clampedDec;
  const rounded = Math.round(num * factor) / factor;
  const parts = rounded.toFixed(clampedDec).split(".");
  const intStr = parts[0].padStart(minIntegerDigits, "0");
  const decStr = parts[1] || "";

  const scaled = num * factor;
  const fractional = scaled - Math.floor(scaled);

  const digits = [];
  for (let i = 0; i < intStr.length; i++) {
    digits.push({ char: intStr[i], isDecimal: false, isRed: false, role: "integer", progress: 0 });
  }
  if (clampedDec > 0) {
    for (let i = 0; i < decStr.length; i++) {
      const isLast = i === decStr.length - 1;
      digits.push({
        char: decStr[i],
        isDecimal: true,
        isRed: true,
        role: "decimal",
        progress: isLast && fractional > 0.01 && fractional < 0.99 ? Math.round(fractional * 100) / 100 : 0,
      });
    }
  } else if (fractional > 0.01 && fractional < 0.99 && digits.length > 0) {
    digits[digits.length - 1].progress = Math.round(fractional * 100) / 100;
  }
  return {
    raw: num,
    intStr,
    decStr,
    clampedDec,
    formatted: clampedDec > 0 ? `${intStr},${decStr}` : intStr,
    digits,
  };
}

export function ferrarisSpeed(powerWatts) {
  if (powerWatts == null || !Number.isFinite(Number(powerWatts))) {
    return { duration: 0, reverse: false, active: false, power: 0 };
  }
  const power = Number(powerWatts);
  const abs = Math.abs(power);
  if (abs < 2) return { duration: 0, reverse: false, active: false, power };
  const duration = Math.max(0.8, Math.min(30, 2400 / abs));
  return {
    duration: Math.round(duration * 10) / 10,
    reverse: power < 0,
    active: true,
    power,
  };
}

export function computeFerrarisDrumPositions(rawValue, decimals = 1, minIntegerDigits = 6) {
  if (rawValue == null || !Number.isFinite(Number(rawValue))) return null;
  const clampedDec = Math.max(0, Math.min(3, Math.round(Number(decimals) || 0)));
  const factor = 10 ** clampedDec;
  const absVal = Math.abs(Number(rawValue));
  const intFloor = Math.floor(absVal);
  const intDigitsCount = Math.max(minIntegerDigits, String(intFloor).length);
  const totalDrums = intDigitsCount + clampedDec;
  const scaled = absVal * factor;

  const positions = new Array(totalDrums);
  for (let idx = totalDrums - 1; idx >= 0; idx--) {
    const placeFromRight = totalDrums - 1 - idx;
    if (placeFromRight === 0) {
      const rem = scaled % 10;
      positions[idx] = rem < 0.005 ? 0 : rem > 9.995 ? 0 : Math.round(rem * 1000) / 1000;
    } else {
      const divisor = 10 ** placeFromRight;
      // Add tiny epsilon to avoid float floor drift like 2.9999999999999996
      const baseDigit = Math.floor((scaled + 1e-9) / divisor) % 10;
      const rightPos = positions[idx + 1];
      const carry = rightPos > 9 ? rightPos - 9 : 0;
      positions[idx] = Math.round((baseDigit + carry) * 1000) / 1000;
    }
  }
  return positions;
}

export function ferrarisSerialNumber(seedText) {
  const str = String(seedText || "powermesh.ferraris");
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const sixDigits = String((hash >>> 0) % 1000000).padStart(6, "0");
  return `21 ${sixDigits.slice(0, 3)} ${sixDigits.slice(3, 6)}`;
}

export function energyToWh(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  const u = unit == null || unit === "" ? "kWh" : String(unit).trim();
  if (u === "Wh") return num;
  if (u === "kWh") return num * 1000;
  if (u === "MWh") return num * 1000000;
  if (u === "GWh") return num * 1000000000;
  if (u === "GJ") return num * (1000000 / 3.6);
  if (u === "MJ") return num * (1000 / 3.6);
  return null;
}

function decayedEstimatedPower(entry, nowMs) {
  if (!entry || entry.estimatedWatts == null) return null;
  if (entry.estimatedWatts === 0) return 0;
  const last = entry.samples[entry.samples.length - 1];
  if (!last) return null;
  const elapsedSec = Math.max(0, (nowMs - last.time) / 1000);
  if (elapsedSec > 3600) return 0;
  const holdSec = Math.min(1800, Math.max(45, (entry.lastIntervalSec || 60) * 1.5));
  if (elapsedSec <= holdSec) return entry.estimatedWatts;
  const decayed = entry.estimatedWatts * (holdSec / elapsedSec);
  return Math.abs(decayed) < 2 ? 0 : decayed;
}

export function estimatePowerFromEnergyChanges(store, entityId, currentVal, unit, options = {}) {
  if (!store || !entityId) return null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const existing = store.get(entityId);
  if (currentVal == null || !Number.isFinite(Number(currentVal))) {
    return decayedEstimatedPower(existing, nowMs);
  }
  const currentWh = energyToWh(currentVal, unit);
  if (currentWh == null) return null;

  const rawStamp = options.sampleTimeMs;
  const stamp = Number.isFinite(rawStamp) && rawStamp <= nowMs + 60000 ? rawStamp : nowMs;
  if (!existing || !Array.isArray(existing.samples) || existing.samples.length === 0) {
    store.set(entityId, {
      samples: [{ val: Number(currentVal), wh: currentWh, time: stamp }],
      estimatedWatts: null,
      lastStepWh: null,
      lastIntervalSec: null,
    });
    return null;
  }

  const last = existing.samples[existing.samples.length - 1];
  if (Math.abs(currentWh - last.wh) < 1e-6) {
    return decayedEstimatedPower(existing, nowMs);
  }

  const effectiveTime = stamp > last.time ? stamp : nowMs > last.time ? nowMs : last.time;
  let anchor = null;
  for (let i = existing.samples.length - 1; i >= 0; i--) {
    if ((effectiveTime - existing.samples[i].time) / 1000 >= 0.5) {
      anchor = existing.samples[i];
      break;
    }
  }

  if (!anchor) {
    return decayedEstimatedPower(existing, nowMs);
  }

  const dtSec = (effectiveTime - anchor.time) / 1000;
  if (dtSec > 7200) {
    existing.samples = [{ val: Number(currentVal), wh: currentWh, time: effectiveTime }];
    existing.estimatedWatts = null;
    existing.lastStepWh = null;
    existing.lastIntervalSec = null;
    return null;
  }

  const deltaWh = currentWh - anchor.wh;
  if (deltaWh < 0 && (options.stateClass === "total_increasing" || currentWh < anchor.wh * 0.5)) {
    existing.samples = [{ val: Number(currentVal), wh: currentWh, time: effectiveTime }];
    existing.estimatedWatts = 0;
    existing.lastStepWh = null;
    return 0;
  }

  const instantWatts = (deltaWh * 3600) / dtSec;
  if (!Number.isFinite(instantWatts) || Math.abs(instantWatts) > 100000) {
    existing.samples = [{ val: Number(currentVal), wh: currentWh, time: effectiveTime }];
    return decayedEstimatedPower(existing, nowMs);
  }

  const prior = decayedEstimatedPower(existing, effectiveTime);
  const smoothed = prior != null && Math.abs(prior) >= 2 && Math.sign(prior) === Math.sign(instantWatts)
    ? instantWatts * 0.7 + prior * 0.3
    : instantWatts;

  existing.samples.push({ val: Number(currentVal), wh: currentWh, time: effectiveTime });
  if (existing.samples.length > 8) existing.samples.shift();
  existing.lastStepWh = Math.abs(deltaWh);
  existing.lastIntervalSec = dtSec;
  existing.estimatedWatts = smoothed;
  return decayedEstimatedPower(existing, nowMs);
}

export function isPowerSensor(state) {
  if (!state) return false;
  const devClass = state.attributes?.device_class;
  const unit = state.attributes?.unit_of_measurement;
  return devClass === "power" || ["W", "kW", "VA", "var"].includes(unit);
}

export function extractWatts(state) {
  if (!state || ["unknown", "unavailable"].includes(state.state)) return null;
  const val = Number(state.state);
  if (!Number.isFinite(val)) return null;
  const unit = state.attributes?.unit_of_measurement;
  if (unit === "kW") return val * 1000;
  return val;
}

export function resolveGridImportPower(hass, item) {
  if (!hass?.states) return null;

  // 1. Explicitly configured disk_power_entity
  if (item?.disk_power_entity && hass.states[item.disk_power_entity]) {
    const w = extractWatts(hass.states[item.disk_power_entity]);
    if (w != null) return w;
  }

  const allEntries = Object.entries(hass.states).map(([id, s]) => ({
    id: (s?.entity_id || id || "").toLowerCase(),
    state: s,
    friendlyName: (s?.attributes?.friendly_name || "").toLowerCase(),
  }));

  // 2. Look for configured grid_import_power in Powermesh overview sensors
  for (const { state: s } of allEntries) {
    const roles = s?.attributes?.roles;
    if (Array.isArray(roles?.grid_import_power) && roles.grid_import_power.length > 0) {
      let sum = 0;
      let found = false;
      for (const id of roles.grid_import_power) {
        const w = extractWatts(hass.states[id]);
        if (w != null) {
          sum += w;
          found = true;
        }
      }
      if (found) return sum;
    }
  }

  // 3. Sibling power sensor if item.entity is set (matching base device name)
  if (item?.entity) {
    const rawId = item.entity.replace(/^sensor\./, "").toLowerCase();
    const baseId = rawId.replace(/_?(total_in|total|energy|energie|kwh|zaehlerstand|zaehler|meter|consumption|bezug)_?/gi, "");
    if (baseId && baseId !== rawId) {
      const sibling = allEntries.find((e) => {
        if (!isPowerSensor(e.state)) return false;
        return e.id.includes(baseId) && (e.id.includes("power") || e.id.includes("leistung") || e.id.includes("watt") || e.id.includes("current"));
      });
      if (sibling) {
        const w = extractWatts(sibling.state);
        if (w != null) return w;
      }
    }
  }

  // 4. Dedicated Netzbezug / grid import power sensors
  const netzbezugCandidate = allEntries.find((e) => {
    if (!isPowerSensor(e.state)) return false;
    return (
      e.id.includes("grid_import") ||
      e.id.includes("netzbezug") ||
      e.id.includes("strom_bezug") ||
      e.id.includes("strombezug") ||
      e.friendlyName.includes("netzbezug") ||
      e.friendlyName.includes("grid import") ||
      e.friendlyName.includes("strombezug")
    );
  });
  if (netzbezugCandidate) {
    const w = extractWatts(netzbezugCandidate.state);
    if (w != null) return w;
  }

  // 5. General grid power sensor
  const gridPowerCandidate = allEntries.find((e) => {
    if (!isPowerSensor(e.state)) return false;
    return (
      e.id.includes("grid_power") ||
      e.id.includes("netzleistung") ||
      e.id.includes("leistung_netz") ||
      e.friendlyName.includes("netzleistung") ||
      e.friendlyName.includes("grid power")
    );
  });
  if (gridPowerCandidate) {
    const w = extractWatts(gridPowerCandidate.state);
    if (w != null) return w;
  }

  // 6. If item.entity itself is already a power sensor
  if (item?.entity && hass.states[item.entity]) {
    const s = hass.states[item.entity];
    if (isPowerSensor(s)) {
      return extractWatts(s);
    }
  }

  return null;
}

export function simulateDiscPhysics(currentVelocity, targetVelocity, dt, tau = 1.8) {
  const clampedDt = Math.max(0, Math.min(dt, 1.0));
  const alpha = 1 - Math.exp(-clampedDt / Math.max(0.01, tau));
  let v = currentVelocity + (targetVelocity - currentVelocity) * alpha;
  if (Math.abs(v) < 0.05 && targetVelocity === 0) {
    v = 0;
  }
  return v;
}

const safeRaf = typeof requestAnimationFrame === "function"
  ? requestAnimationFrame
  : (cb) => setTimeout(() => cb((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()), 16);
const safeCaf = typeof cancelAnimationFrame === "function"
  ? cancelAnimationFrame
  : (id) => clearTimeout(id);

export function meterStyleConfig(config) {
  if (!config) return [];
  if (Array.isArray(config.entities) && config.entities.length > 0) {
    return config.entities.map((item) => (typeof item === "string" ? { entity: item } : item));
  }
  if (config.entity) {
    return [{
      entity: config.entity,
      name: config.name,
      style: config.style,
      disk_power_entity: config.disk_power_entity,
      decimals: config.decimals,
      unit: config.unit,
    }];
  }
  return [];
}

export function renderVfdDigitSvg(char) {
  const active = VFD_SEGMENTS[char] || [];
  const seg = (id, points) => `<polygon class="seg ${active.includes(id) ? "on" : "off"}" points="${points}" />`;
  return `<svg viewBox="0 0 24 38" preserveAspectRatio="xMidYMid meet">` +
    seg("a", "4,2 18,2 16,5 6,5") +
    seg("b", "19,3 21,5 19,18 17,16 17,5") +
    seg("c", "19,20 21,22 19,35 17,33 17,22") +
    seg("d", "4,36 18,36 16,33 6,33") +
    seg("e", "3,20 5,22 5,33 3,35 1,33 1,22") +
    seg("f", "3,3 5,5 5,16 3,18 1,16 1,5") +
    seg("g", "4,19 6,17 16,17 18,19 16,21 6,21") +
    `</svg>`;
}


const FERRARIS_DRUM_HEIGHT = 32;
const FERRARIS_HISTORY_LOOKBACK_MS = 2 * 3600 * 1000;

function createFerrarisSvg(viewBox, innerMarkup, className = "") {
  const wrap = document.createElement("span");
  if (className) wrap.className = className;
  wrap.setAttribute("aria-hidden", "true");
  wrap.innerHTML = `<svg viewBox="${viewBox}" focusable="false">${innerMarkup}</svg>`;
  return wrap;
}

export function drawFerrarisDiscCanvas(canvas, position = 0, velocity = 0, reverse = false) {
  if (!canvas || typeof canvas.getContext !== "function") return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const cssW = canvas.clientWidth || 220;
  const cssH = canvas.clientHeight || 22;
  const dpr = Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 2);
  const pw = Math.max(120, Math.round(cssW * dpr));
  const ph = Math.max(16, Math.round(cssH * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }

  const W = pw / dpr;
  const H = ph / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // 1. Deep recessed black cavity
  const cavityGrad = ctx.createLinearGradient(0, 0, 0, H);
  cavityGrad.addColorStop(0, "#010203");
  cavityGrad.addColorStop(0.3, "#090b0e");
  cavityGrad.addColorStop(0.7, "#090b0e");
  cavityGrad.addColorStop(1, "#010203");
  ctx.fillStyle = cavityGrad;
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2;
  const R = W * 0.475;
  const discH = Math.max(7.5, Math.min(10.2, H * 0.72));
  const discTop = (H - discH) / 2;
  const discBottom = discTop + discH;

  // 2. Subtle vertical rotor spindle / axle in cavity above/below disc
  const shaftW = 2.4;
  const shaftGrad = ctx.createLinearGradient(cx - shaftW / 2, 0, cx + shaftW / 2, 0);
  shaftGrad.addColorStop(0, "#101216");
  shaftGrad.addColorStop(0.5, "#464b54");
  shaftGrad.addColorStop(1, "#0e1014");
  ctx.fillStyle = shaftGrad;
  ctx.fillRect(cx - shaftW / 2, 0.5, shaftW, H - 1);

  // 3. Front 3D cylindrical machined aluminum disc rim
  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(cx - R, discTop, R * 2, discH, 0.8);
  } else {
    ctx.rect(cx - R, discTop, R * 2, discH);
  }
  ctx.clip();

  const rimGrad = ctx.createLinearGradient(cx - R, 0, cx + R, 0);
  rimGrad.addColorStop(0.0, "#34383f");
  rimGrad.addColorStop(0.05, "#a6acb5");
  rimGrad.addColorStop(0.22, "#f3f5f8");
  rimGrad.addColorStop(0.42, "#cfd4dc");
  rimGrad.addColorStop(0.54, "#b8bec8");
  rimGrad.addColorStop(0.78, "#f4f6f9");
  rimGrad.addColorStop(0.95, "#9ea4ae");
  rimGrad.addColorStop(1.0, "#2f333a");
  ctx.fillStyle = rimGrad;
  ctx.fillRect(cx - R, discTop, R * 2, discH);

  // Rotation angle: forward consumption (velocity < 0 -> position decreases) rotates left-to-right (+angle)
  const angle = (-position / 50) * Math.PI * 2;
  const normAngle = Math.atan2(Math.sin(angle), Math.cos(angle));
  const speedAbs = Math.abs(velocity);

  // 4. Fine circumferential milled knurling graduations (160 divisions around 360°)
  const toothContrast = Math.max(0.14, 1 - Math.min(0.84, speedAbs / 70));
  const teethCount = 160;
  for (let k = 0; k < teethCount; k++) {
    const theta = angle + (k / teethCount) * Math.PI * 2;
    const cosT = Math.cos(theta);
    if (cosT <= 0.03) continue;
    const sinT = Math.sin(theta);
    const x = cx + R * sinT;
    const pitch = ((Math.PI * 2 * R) / teethCount) * cosT;

    const grooveAlpha = 0.78 * toothContrast * (0.35 + 0.65 * cosT);
    ctx.fillStyle = `rgba(16, 18, 22, ${grooveAlpha.toFixed(3)})`;
    ctx.fillRect(x - pitch * 0.25, discTop + 0.35, Math.max(0.45, pitch * 0.34), discH - 0.7);

    const ridgeAlpha = 0.62 * toothContrast * (0.25 + 0.75 * cosT);
    ctx.fillStyle = `rgba(255, 255, 255, ${ridgeAlpha.toFixed(3)})`;
    ctx.fillRect(x + pitch * 0.1, discTop + 0.35, Math.max(0.4, pitch * 0.30), discH - 0.7);
  }

  // 5. Crisp lacquer calibration mark (Eichmarke) painted onto the milled rim
  const halfArc = 0.155;
  const markStart = Math.max(-Math.PI / 2, normAngle - halfArc);
  const markEnd = Math.min(Math.PI / 2, normAngle + halfArc);
  if (markEnd > markStart) {
    const x1 = cx + R * Math.sin(markStart);
    const x2 = cx + R * Math.sin(markEnd);
    const trail = Math.min(14, speedAbs * 0.14);
    const drawLeft = velocity < 0 ? x1 - trail : x1;
    const drawRight = velocity > 0 ? x2 + trail : x2;
    const markW = Math.max(1.5, drawRight - drawLeft);
    const markGrad = ctx.createLinearGradient(drawLeft, 0, drawRight, 0);
    if (trail > 1.2 && velocity < 0) {
      markGrad.addColorStop(0, "rgba(175, 28, 28, 0.05)");
      markGrad.addColorStop(Math.min(0.45, trail / markW), "rgba(175, 28, 28, 0.85)");
      markGrad.addColorStop(0.75, "#b91c1c");
      markGrad.addColorStop(1, "#7f1d1d");
    } else if (trail > 1.2 && velocity > 0) {
      markGrad.addColorStop(0, "#7f1d1d");
      markGrad.addColorStop(0.25, "#b91c1c");
      markGrad.addColorStop(Math.max(0.55, 1 - trail / markW), "rgba(175, 28, 28, 0.85)");
      markGrad.addColorStop(1, "rgba(175, 28, 28, 0.05)");
    } else {
      markGrad.addColorStop(0, "#5c1414");
      markGrad.addColorStop(0.12, "#a31d1d");
      markGrad.addColorStop(0.5, "#c52222");
      markGrad.addColorStop(0.88, "#9e1b1b");
      markGrad.addColorStop(1, "#5c1414");
    }
    ctx.fillStyle = markGrad;
    ctx.fillRect(drawLeft, discTop + 0.3, markW, discH - 0.6);

    // Subtle milled texture showing faintly through the painted lacquer
    for (let k = 0; k < teethCount; k++) {
      const theta = angle + (k / teethCount) * Math.PI * 2;
      const rel = Math.atan2(Math.sin(theta - normAngle), Math.cos(theta - normAngle));
      if (Math.abs(rel) > halfArc || Math.cos(theta) <= 0.05) continue;
      const tx = cx + R * Math.sin(theta);
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.22 * toothContrast).toFixed(3)})`;
      ctx.fillRect(tx, discTop + 0.5, 0.6, discH - 1.0);
    }
  }

  // Spun-metal horizontal motion sheen at higher velocities
  if (speedAbs > 12) {
    const sheenAlpha = Math.min(0.3, (speedAbs - 12) / 140);
    const sheenGrad = ctx.createLinearGradient(0, discTop, 0, discBottom);
    sheenGrad.addColorStop(0, `rgba(255,255,255,${(sheenAlpha * 0.85).toFixed(3)})`);
    sheenGrad.addColorStop(0.5, `rgba(240,244,248,${sheenAlpha.toFixed(3)})`);
    sheenGrad.addColorStop(1, `rgba(0,0,0,${(sheenAlpha * 0.7).toFixed(3)})`);
    ctx.fillStyle = sheenGrad;
    ctx.fillRect(cx - R, discTop, R * 2, discH);
  }

  // Crisp metallic top & bottom edge bevels
  const rimVert = ctx.createLinearGradient(0, discTop, 0, discBottom);
  rimVert.addColorStop(0, "rgba(255, 255, 255, 0.62)");
  rimVert.addColorStop(0.16, "rgba(255, 255, 255, 0.08)");
  rimVert.addColorStop(0.8, "rgba(0, 0, 0, 0.08)");
  rimVert.addColorStop(1, "rgba(0, 0, 0, 0.68)");
  ctx.fillStyle = rimVert;
  ctx.fillRect(cx - R, discTop, R * 2, discH);

  // Subtle curved falloff only at the outermost 8% tangent ends
  const edgeShadeL = ctx.createLinearGradient(cx - R, 0, cx - R + R * 0.1, 0);
  edgeShadeL.addColorStop(0, "rgba(8, 9, 12, 0.75)");
  edgeShadeL.addColorStop(1, "rgba(8, 9, 12, 0)");
  ctx.fillStyle = edgeShadeL;
  ctx.fillRect(cx - R, discTop, R * 0.1, discH);

  const edgeShadeR = ctx.createLinearGradient(cx + R - R * 0.1, 0, cx + R, 0);
  edgeShadeR.addColorStop(0, "rgba(8, 9, 12, 0)");
  edgeShadeR.addColorStop(1, "rgba(8, 9, 12, 0.75)");
  ctx.fillStyle = edgeShadeR;
  ctx.fillRect(cx + R - R * 0.1, discTop, R * 0.1, discH);

  ctx.restore();

  // 6. Crisp recessed slot lip shadow
  const slotShadow = ctx.createLinearGradient(0, 0, 0, H);
  slotShadow.addColorStop(0, "rgba(0, 0, 0, 0.7)");
  slotShadow.addColorStop(0.18, "rgba(0, 0, 0, 0)");
  slotShadow.addColorStop(0.84, "rgba(0, 0, 0, 0)");
  slotShadow.addColorStop(1, "rgba(0, 0, 0, 0.6)");
  ctx.fillStyle = slotShadow;
  ctx.fillRect(0, 0, W, H);
}

export class PowermeshMeterCard extends HTMLElement {
  constructor() {
    super();
    this._discAnimations = new Map();
    this._energyEstimator = new Map();
    this._seededHistoryEntities = new Set();
    this._historyLoadingEntities = new Set();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; border-radius: var(--ha-card-border-radius, 12px); box-sizing: border-box; }
        header { display: flex; align-items: center; gap: 12px; padding: 16px 20px 10px; }
        header ha-icon { color: var(--primary-color); flex: none; }
        h2 { flex: 1; min-width: 0; margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
        .mode-badge { font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 10px; background: var(--secondary-background-color); color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.5px; }
        .meters-body { padding: 4px 16px 16px; display: flex; flex-direction: column; gap: 16px; }
        ha-card.no-header header { display: none; }
        ha-card.no-header .meters-body { padding: 16px; }
        .meter-card-empty { padding: 24px 16px; text-align: center; color: var(--secondary-text-color); font-size: 14px; }

        .style-modern { background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #e0e0e0); border-radius: 8px; padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
        .modern-header { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--secondary-text-color); }
        .modern-display { display: flex; align-items: baseline; gap: 8px; font-variant-numeric: tabular-nums; }
        .modern-value { font-size: 34px; font-weight: 700; line-height: 1.1; color: var(--primary-text-color); letter-spacing: -0.5px; }
        .modern-unit { font-size: 16px; font-weight: 600; color: var(--secondary-text-color); }
        .modern-meta { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--secondary-text-color); border-top: 1px solid var(--divider-color, #eee); padding-top: 8px; margin-top: 4px; }
        .modern-power-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; background: var(--secondary-background-color); font-weight: 500; }
        .modern-power-badge.export { color: var(--success-color, #10b981); }

        /* Style 1: Authentic Ferraris Induktionszähler (Bakelite housing & brushed silver dial plate) */
        .style-ferraris {
          background:
            radial-gradient(ellipse at 50% 0%, rgba(255,255,255,0.16) 0%, transparent 55%),
            linear-gradient(168deg, #24272c 0%, #111316 14%, #08090b 65%, #14161a 100%);
          border: 1.5px solid #2b2e34;
          border-radius: 18px;
          padding: 17px 18px 19px;
          box-shadow:
            inset 0 2px 3px rgba(255, 255, 255, 0.30),
            inset 0 -4px 8px rgba(0, 0, 0, 0.92),
            inset 3px 0 4px rgba(255, 255, 255, 0.09),
            inset -3px 0 4px rgba(255, 255, 255, 0.06),
            0 10px 24px rgba(0, 0, 0, 0.48);
          position: relative;
          user-select: none;
          cursor: pointer;
          box-sizing: border-box;
          font-family: "DIN Alternate", "Bahnschrift", "Roboto Condensed", "Arial Narrow", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .style-ferraris::before {
          content: "";
          position: absolute;
          top: 3px;
          left: 16px;
          right: 16px;
          height: 3.5px;
          border-radius: 4px;
          background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.28) 22%, rgba(255,255,255,0.38) 50%, rgba(255,255,255,0.28) 78%, rgba(255,255,255,0.04) 100%);
          pointer-events: none;
        }
        .ferraris-bezel {
          background: linear-gradient(180deg, #030405 0%, #171a1e 100%);
          border-radius: 11px;
          padding: 4px;
          box-shadow: 0 1px 1px rgba(255, 255, 255, 0.16), inset 0 3px 7px rgba(0, 0, 0, 0.98);
        }
        .ferraris-faceplate {
          position: relative;
          overflow: hidden;
          border-radius: 8px;
          background:
            repeating-linear-gradient(90deg, rgba(255,255,255,0.018) 0px, rgba(255,255,255,0.018) 1px, rgba(0,0,0,0.012) 1px, rgba(0,0,0,0.012) 2px),
            radial-gradient(ellipse at 50% 22%, #e6e8e9 0%, #dadde0 56%, #c8cdd1 100%);
          box-shadow:
            inset 0 5px 11px rgba(0, 0, 0, 0.36),
            inset 0 -4px 9px rgba(0, 0, 0, 0.22),
            inset 4px 0 9px rgba(0, 0, 0, 0.20),
            inset -4px 0 9px rgba(0, 0, 0, 0.20);
          padding: 14px 16px 12px;
          color: #1c1e22;
          display: flex;
          flex-direction: column;
          gap: 9px;
        }
        .ferraris-glass-reflection {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 4;
          background: linear-gradient(124deg, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0.07) 26%, rgba(255,255,255,0) 37%, rgba(255,255,255,0) 78%, rgba(255,255,255,0.08) 100%);
        }
        .ferraris-register-row {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;
          gap: 10px;
          margin-top: 2px;
        }
        .ferraris-safety-marks {
          justify-self: end;
          margin-right: 4px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          color: #202327;
        }
        .ferraris-safety-marks svg { width: 17px; height: 36px; display: block; }
        .ferraris-register-col {
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .ferraris-odometer-housing {
          display: inline-flex;
          align-items: stretch;
          background: #1d2024;
          border-radius: 2px;
          box-shadow: 0 1px 0 rgba(255,255,255,0.55), 0 2px 5px rgba(0,0,0,0.28);
          position: relative;
        }
        .ferraris-drums-int-wrap {
          padding: 5px 3px 5px 6px;
          background: #202327;
          display: flex;
          align-items: center;
          position: relative;
        }
        .ferraris-drums-int-wrap.all-integer {
          padding-right: 6px;
        }
        .ferraris-drums-dec-wrap {
          padding: 5px 10px 5px 3px;
          background: #bf2c27;
          display: flex;
          align-items: center;
          position: relative;
        }
        /* White/silver graduation ticks on the right red decimal border */
        .ferraris-drums-dec-wrap::after {
          content: "";
          position: absolute;
          right: 1.5px;
          top: 9px;
          bottom: 9px;
          width: 4px;
          background: linear-gradient(
            180deg,
            transparent 0%,
            transparent 18%,
            rgba(240,242,244,0.88) 18%,
            rgba(240,242,244,0.88) 24%,
            transparent 24%,
            transparent 47%,
            rgba(240,242,244,0.95) 47%,
            rgba(240,242,244,0.95) 53%,
            transparent 53%,
            transparent 76%,
            rgba(240,242,244,0.88) 76%,
            rgba(240,242,244,0.88) 82%,
            transparent 82%
          );
          pointer-events: none;
        }
        /* Angled white comma mark at bottom seam between integer and decimal frames */
        .ferraris-comma-wedge {
          position: absolute;
          bottom: 0;
          left: -2.5px;
          width: 3px;
          height: 8px;
          background: #eef0f2;
          transform: skewX(-20deg);
          z-index: 3;
          pointer-events: none;
          box-shadow: 0 0 1px rgba(0,0,0,0.5);
        }
        .ferraris-drums {
          display: flex;
          gap: 2px;
          background: #08090b;
          padding: 2px 3px;
          box-shadow: inset 0 2px 5px rgba(0,0,0,0.95);
        }
        .ferraris-drum {
          --drum-win-h: 30px;
          --drum-step: 24px;
          width: 20px;
          height: var(--drum-win-h);
          position: relative;
          overflow: hidden;
          border-radius: 1px;
          background-color: #16181b;
          color: #f3f4f6;
          box-shadow: inset 0 0 2px rgba(0,0,0,0.75);
          font-size: 20.5px;
          font-weight: 700;
          line-height: var(--drum-step);
          text-align: center;
          font-variant-numeric: tabular-nums;
        }
        .ferraris-drum::after {
          content: "";
          position: absolute;
          left: 1px;
          bottom: 1px;
          width: 2px;
          height: 3px;
          background: rgba(215, 220, 226, 0.42);
          border-radius: 0.5px;
          pointer-events: none;
          z-index: 2;
        }
        .ferraris-drum-ribbon {
          display: flex;
          flex-direction: column;
          position: absolute;
          top: calc((var(--drum-win-h) - var(--drum-step)) / 2 - var(--drum-step));
          left: 0;
          right: 0;
          will-change: transform;
        }
        .ferraris-drum-ribbon.animated { transition: transform 0.55s cubic-bezier(0.22, 0.8, 0.32, 1); }
        .ferraris-digit-cell { height: var(--drum-step); line-height: var(--drum-step); text-align: center; flex: none; }
        .ferraris-drum-shade {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 2;
          background-image: linear-gradient(
            180deg,
            rgba(0,0,0,0.72) 0%,
            rgba(0,0,0,0.16) 22%,
            rgba(255,255,255,0.07) 36%,
            transparent 50%,
            rgba(0,0,0,0.18) 76%,
            rgba(0,0,0,0.76) 100%
          );
        }
        .ferraris-unit-tag {
          justify-self: start;
          color: #1c1e22;
          font-weight: 800;
          font-size: 18px;
          letter-spacing: -0.2px;
          padding-left: 2px;
        }
        .ferraris-keeper-tab {
          width: 24px;
          height: 7px;
          margin-top: 7px;
          background: linear-gradient(180deg, #0d0e11 0%, #0d0e11 45%, #8a7b58 46%, #a89872 76%, #5d523a 100%);
          border-radius: 1px;
          box-shadow: inset 0 1px 2px rgba(0,0,0,0.9), 0 1px 0 rgba(255,255,255,0.55);
        }

        .ferraris-nameplate {
          display: flex;
          flex-direction: column;
          gap: 3px;
          margin-top: 1px;
        }
        .ferraris-brand-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: end;
          gap: 8px;
        }
        .ferraris-brand {
          font-size: 16px;
          font-weight: 800;
          letter-spacing: -0.3px;
          color: #191b1f;
          line-height: 1.05;
        }
        .ferraris-designation {
          font-size: 12.5px;
          font-weight: 700;
          color: #1f2226;
          text-align: center;
          line-height: 1.15;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .ferraris-ptb-box {
          border: 1px solid #25282c;
          font-size: 8.5px;
          font-weight: 700;
          line-height: 1.1;
          color: #1f2226;
          text-align: center;
          font-variant-numeric: tabular-nums;
        }
        .ferraris-ptb-box div { padding: 1px 3px; }
        .ferraris-ptb-box div + div { border-top: 1px solid #25282c; }
        .ferraris-rule {
          height: 1.2px;
          background: #23262a;
          width: 100%;
        }
        .ferraris-specs-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 700;
          color: #1c1f23;
          padding-top: 1px;
        }
        .ferraris-amp-badge {
          background: rgba(247, 248, 249, 0.62);
          border-radius: 3px;
          padding: 1px 6px;
          font-weight: 600;
          box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.08);
        }

        .ferraris-rotor-section {
          display: flex;
          flex-direction: column;
          align-items: center;
          margin: 3px 0 1px;
        }
        .ferraris-rotor-row {
          width: 100%;
          display: grid;
          grid-template-columns: minmax(28px, 1fr) minmax(150px, 64%) minmax(28px, 1fr);
          align-items: center;
        }
        .ferraris-arrow {
          display: flex;
          align-items: center;
          color: #1b1e22;
          height: 14px;
        }
        .ferraris-arrow svg { width: 100%; height: 14px; display: block; overflow: visible; }
        .ferraris-chamber {
          width: 100%;
          background: #17191d;
          border: 1.5px solid #121417;
          border-radius: 1px;
          padding: 4.5px 9px;
          box-sizing: border-box;
          box-shadow: 0 1px 0 rgba(255,255,255,0.5), inset 0 1px 3px rgba(0,0,0,0.95);
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        .ferraris-chamber.solar-export {
          border-color: #1f6f54;
          box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.38), inset 0 1px 3px rgba(0,0,0,0.95);
        }
        .ferraris-window {
          width: 100%;
          height: 13px;
          position: relative;
          overflow: hidden;
          border-radius: 0.5px;
          background: #040507;
        }
        .ferraris-disc-canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          z-index: 2;
        }
        .ferraris-window-glass {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 3;
          background: linear-gradient(180deg, rgba(255,255,255,0.16) 0%, transparent 42%, rgba(0,0,0,0.28) 100%);
        }
        .ferraris-disc-track {
          position: absolute;
          top: 6px;
          bottom: 6px;
          left: 5%;
          width: 180%;
          display: flex;
          will-change: transform;
          transform: translate3d(0, 0, 0);
          z-index: 1;
          opacity: 0.9;
        }
        .ferraris-disc-half {
          width: 50%;
          height: 100%;
          position: relative;
          background: repeating-linear-gradient(90deg, #d8dce2 0px, #d8dce2 2px, #2b2e33 2px, #2b2e33 4px);
        }
        .ferraris-mark { position: absolute; top: 0; bottom: 0; left: 45%; width: 12px; background: #b71c1c; }
        .ferraris-center-tick {
          width: 3px;
          height: 8px;
          background: #1b1e22;
          margin-top: 0;
        }

        .ferraris-bottom-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          gap: 10px;
          margin-top: 2px;
        }
        .ferraris-serial-col {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: 11px;
          font-weight: 600;
          color: #202327;
          line-height: 1.22;
        }
        .ferraris-nr-line {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-bottom: 1px;
        }
        .ferraris-nr-plate {
          background: #1d2024;
          color: #f1f3f5;
          padding: 1px 6px;
          border-radius: 1px;
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.5px;
          font-variant-numeric: tabular-nums;
          box-shadow: inset 0 1px 2px rgba(0,0,0,0.7);
        }
        .ferraris-serial-origin {
          font-size: 7.5px;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          color: #363a40;
          margin-top: 1px;
        }
        .ferraris-right-col {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 5px;
          min-width: 0;
        }
        .ferraris-power-info {
          font-size: 10.5px;
          font-weight: 700;
          color: #1f2328;
          background: rgba(248, 249, 250, 0.56);
          border: 1px solid rgba(32, 35, 39, 0.18);
          border-radius: 3px;
          padding: 2px 6px;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .ferraris-power-info.export {
          color: #115e3b;
          background: rgba(209, 250, 229, 0.65);
          border-color: rgba(17, 94, 59, 0.32);
        }
        .ferraris-power-info.estimated {
          font-weight: 600;
        }
        .ferraris-compliance {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .ferraris-sticker-badge {
          background: rgba(244, 246, 247, 0.68);
          border: 1px solid rgba(0, 0, 0, 0.09);
          border-radius: 3px;
          padding: 2px 4px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #23262a;
        }
        .ferraris-sticker-badge svg { height: 18px; width: auto; display: block; }

        @media (max-width: 390px) {
          .style-ferraris { padding: 11px; }
          .ferraris-faceplate { padding: 11px 10px 10px; }
          .ferraris-drum { --drum-win-h: 26px; --drum-step: 21px; width: 17px; font-size: 18px; }
          .ferraris-unit-tag { font-size: 15px; }
          .ferraris-specs-row { font-size: 10.5px; }
        }

        .style-nixie { background: radial-gradient(ellipse at 50% 20%, #1c1108 0%, #0d0703 60%, #050301 100%); border: 2px solid #3d2310; border-radius: 10px; padding: 16px 18px 20px; box-shadow: inset 0 2px 8px rgba(0,0,0,0.9), 0 6px 16px rgba(0,0,0,0.5); display: flex; flex-direction: column; align-items: center; gap: 12px; cursor: pointer; }
        .nixie-title { color: #ff9d42; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; text-shadow: 0 0 6px rgba(255, 120, 0, 0.4); }
        .nixie-display { display: inline-flex; align-items: flex-end; gap: 4px; padding: 8px 12px; background: #080402; border: 1px solid #281406; border-radius: 8px; box-shadow: inset 0 4px 12px rgba(0,0,0,0.95), 0 0 15px rgba(255, 100, 0, 0.15); }
        .nixie-tube { width: 28px; height: 48px; border-radius: 14px 14px 4px 4px; background: radial-gradient(ellipse at 50% 30%, rgba(255, 140, 40, 0.15) 0%, rgba(20, 10, 5, 0.85) 100%); border: 1px solid rgba(255, 170, 70, 0.3); box-shadow: inset 0 0 8px rgba(255, 100, 0, 0.25), 0 0 10px rgba(255, 80, 0, 0.15); position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; }
        .nixie-tube-glass { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: linear-gradient(135deg, rgba(255,255,255,0.2) 0%, transparent 40%, rgba(0,0,0,0.4) 100%); pointer-events: none; z-index: 2; }
        .nixie-mesh { position: absolute; top: 4px; left: 4px; right: 4px; bottom: 4px; background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,160,80,0.06) 2px, rgba(255,160,80,0.06) 4px); pointer-events: none; z-index: 1; }
        .nixie-digit { font-family: "Courier New", Courier, monospace; font-size: 32px; font-weight: 700; color: #ffebc0; text-shadow: 0 0 4px #ff9500, 0 0 12px #ff5900, 0 0 24px rgba(255, 68, 0, 0.9); position: relative; z-index: 1; animation: nixie-flicker 4s infinite alternate; }
        @keyframes nixie-flicker { 0%, 100% { opacity: 1; text-shadow: 0 0 4px #ff9500, 0 0 12px #ff5900, 0 0 24px rgba(255, 68, 0, 0.9); } 50% { opacity: 0.96; text-shadow: 0 0 3px #ff9500, 0 0 10px #ff5900, 0 0 20px rgba(255, 68, 0, 0.75); } 92% { opacity: 0.98; } 94% { opacity: 0.88; } }
        .nixie-dot-tube { width: 12px; height: 24px; border-radius: 6px; background: rgba(20, 10, 5, 0.85); border: 1px solid rgba(255, 170, 70, 0.25); display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
        .nixie-dot { width: 6px; height: 6px; border-radius: 50%; background: #ffebc0; box-shadow: 0 0 4px #ff9500, 0 0 10px #ff5900; }
        .nixie-unit { color: #ff8a00; font-size: 14px; font-weight: 700; letter-spacing: 1px; text-shadow: 0 0 8px #ff5900; padding-left: 6px; align-self: center; }
        .style-vfd { background: #04090b; border: 2px solid #0c2024; border-radius: 8px; padding: 16px 20px; box-shadow: inset 0 3px 12px rgba(0,0,0,0.95), 0 4px 14px rgba(0,0,0,0.6); display: flex; flex-direction: column; gap: 10px; position: relative; overflow: hidden; cursor: pointer; }
        .vfd-grid-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0, 245, 212, 0.02) 3px, rgba(0, 245, 212, 0.02) 4px); pointer-events: none; z-index: 2; }
        .vfd-header { display: flex; justify-content: space-between; align-items: center; font-size: 11px; letter-spacing: 1.5px; color: #00ffd5; text-shadow: 0 0 4px rgba(0, 255, 213, 0.5); text-transform: uppercase; z-index: 1; }
        .vfd-display { display: inline-flex; align-items: flex-end; gap: 4px; padding: 10px 14px; background: #020608; border: 1px solid #0a1f23; border-radius: 6px; box-shadow: inset 0 2px 8px rgba(0,0,0,0.9), 0 0 12px rgba(0, 245, 212, 0.1); z-index: 1; }
        .vfd-digit { width: 24px; height: 38px; }
        .vfd-digit svg { width: 100%; height: 100%; filter: drop-shadow(0 0 4px rgba(0, 245, 212, 0.7)); }
        .vfd-digit .seg.on { fill: #00f5d4; }
        .vfd-digit .seg.off { fill: rgba(0, 245, 212, 0.06); }
        .vfd-dot { width: 6px; height: 6px; border-radius: 50%; background: #00f5d4; box-shadow: 0 0 6px #00f5d4; margin: 0 2px 4px 2px; }
        .vfd-unit { color: #00f5d4; font-size: 14px; font-weight: 700; letter-spacing: 1px; text-shadow: 0 0 6px rgba(0, 245, 212, 0.7); align-self: center; padding-left: 6px; }
        /* Style 5: EBZ Digitalzähler */
        .style-ebz { background: linear-gradient(180deg, #eaecef 0%, #d8dce0 100%); border: 2px solid #b8c0c8; border-radius: 10px; padding: 14px 16px; box-shadow: inset 0 1px 1px rgba(255,255,255,0.8), 0 4px 12px rgba(0,0,0,0.3); color: #2c3437; display: flex; flex-direction: column; gap: 10px; cursor: pointer; }
        .ebz-header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #c0c8d0; padding-bottom: 4px; }
        .ebz-brand { font-size: 13px; font-weight: 800; letter-spacing: 0.5px; color: #1a2327; }
        .ebz-sub { font-size: 10px; color: #5a646a; letter-spacing: 0.5px; }
        .ebz-main { display: flex; gap: 12px; align-items: center; }
        .ebz-optical-port { width: 40px; height: 40px; border-radius: 50%; background: radial-gradient(circle, #555 0%, #222 45%, #999 50%, #bbb 65%, #666 75%, #333 100%); box-shadow: inset 0 2px 4px rgba(0,0,0,0.8), 0 1px 2px rgba(255,255,255,0.6); display: flex; align-items: center; justify-content: center; gap: 6px; flex: none; }
        .ebz-diode { width: 5px; height: 5px; border-radius: 50%; background: #111; box-shadow: inset 0 0 2px rgba(0,0,0,0.9); }
        .ebz-lcd { flex: 1; min-width: 0; background: #c5d4a4; border: 2px solid #8e9b73; border-radius: 5px; padding: 6px 10px; box-shadow: inset 0 2px 6px rgba(0,0,0,0.25); display: flex; flex-direction: column; gap: 4px; font-family: "Courier New", Courier, monospace; }
        .ebz-lcd-top { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px dotted rgba(30, 40, 20, 0.4); padding-bottom: 2px; }
        .ebz-obis { font-size: 11px; font-weight: 700; color: #253318; letter-spacing: 0.5px; }
        .ebz-digits { font-size: 26px; font-weight: 800; color: #15220c; letter-spacing: 1px; }
        .ebz-unit { font-size: 13px; font-weight: 700; color: #253318; padding-left: 4px; }
        .ebz-lcd-bottom { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 700; color: #253318; }
        .ebz-phases { letter-spacing: 1px; color: #2f4020; }
        .ebz-power { color: #15220c; }
        .ebz-power.export { color: #1a5e20; }
        .ebz-specs-footer { font-size: 9px; color: #68737a; display: flex; justify-content: space-between; }

        /* Style 6: EMH Smart Meter */
        .style-emh { background: linear-gradient(180deg, #f8f9fa 0%, #e9ecef 100%); border: 2px solid #ced4da; border-radius: 10px; padding: 14px 16px; box-shadow: inset 0 1px 1px rgba(255,255,255,0.9), 0 4px 12px rgba(0,0,0,0.25); color: #212529; display: flex; flex-direction: column; gap: 10px; cursor: pointer; position: relative; }
        .emh-stripe { position: absolute; top: 0; left: 16px; right: 16px; height: 3px; background: #0066b2; border-radius: 0 0 3px 3px; }
        .emh-header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #dee2e6; padding-bottom: 4px; margin-top: 2px; }
        .emh-logo { font-size: 13px; font-weight: 900; color: #0066b2; letter-spacing: 0.5px; }
        .emh-model { font-size: 10px; color: #6c757d; font-weight: 600; letter-spacing: 0.5px; }
        .emh-main { display: flex; gap: 12px; align-items: center; }
        .emh-optics { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: none; }
        .emh-led { width: 7px; height: 7px; border-radius: 50%; background: #ff1744; box-shadow: 0 0 5px rgba(255, 23, 68, 0.8); animation: emh-pulse 1.8s infinite; }
        .emh-led-label { font-size: 8px; color: #6c757d; font-weight: 700; letter-spacing: 0.2px; }
        @keyframes emh-pulse { 0%, 100% { opacity: 0.3; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.1); } }
        .emh-optical-port { width: 34px; height: 34px; border-radius: 50%; background: radial-gradient(circle, #222 0%, #111 60%, #888 70%, #444 100%); border: 1px solid #777; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 13px; }
        .emh-lcd { flex: 1; min-width: 0; background: #d4dde2; border: 2px solid #9aa8b2; border-radius: 6px; padding: 6px 10px; box-shadow: inset 0 2px 6px rgba(0,0,0,0.2); display: flex; flex-direction: column; gap: 4px; font-family: "Courier New", Courier, monospace; }
        .emh-lcd-top { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid rgba(24, 34, 38, 0.2); padding-bottom: 2px; }
        .emh-tariff { font-size: 9px; font-weight: 800; padding: 1px 3px; background: rgba(24, 34, 38, 0.15); border-radius: 2px; color: #182226; }
        .emh-obis { font-size: 11px; font-weight: 700; color: #182226; margin-left: 3px; }
        .emh-digits { font-size: 26px; font-weight: 800; color: #0f1619; letter-spacing: 1px; }
        .emh-unit { font-size: 13px; font-weight: 700; color: #182226; padding-left: 4px; }
        .emh-lcd-bottom { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 700; color: #182226; }
        .emh-power { display: flex; align-items: center; gap: 4px; }
        .emh-power.export { color: #00796b; }
        .emh-specs-footer { font-size: 9px; color: #6c757d; display: flex; justify-content: space-between; }

      </style>
      <ha-card>
        <header>
          <ha-icon icon="mdi:counter"></ha-icon>
          <h2></h2>
          <span class="mode-badge">Zähler</span>
        </header>
        <div class="meters-body"></div>
      </ha-card>`;
  }

  static getConfigElement() { return document.createElement("powermesh-meter-card-editor"); }

  static getStubConfig(hass) {
    const candidates = hass && hass.states ? Object.values(hass.states) : [];
    const energyEntity = candidates.find(
      (s) => s.attributes?.device_class === "energy" || s.attributes?.unit_of_measurement === "kWh"
    )?.entity_id;
    const powerEntity = candidates.find(
      (s) => s.attributes?.device_class === "power" || ["W", "kW"].includes(s.attributes?.unit_of_measurement)
    )?.entity_id;
    return {
      entity: energyEntity || "",
      name: "Netzbezug",
      style: "ferraris",
      decimals: 1,
      disk_power_entity: powerEntity || "",
      animate_digits: true,
      show_header: true,
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Ungültige Kartenkonfiguration");
    this._config = { show_header: true, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    if (!this._estimateTimer && typeof window !== "undefined" && typeof window.setInterval === "function") {
      this._estimateTimer = window.setInterval(() => {
        if (this._config && this._hass) this._render();
      }, 10000);
    }
    if (this._config) this._render();
  }

  disconnectedCallback() {
    if (this._estimateTimer != null && typeof window !== "undefined" && typeof window.clearInterval === "function") {
      window.clearInterval(this._estimateTimer);
    }
    this._estimateTimer = null;
    this._stopDiscAnimations();
  }

  _calcTargetVelocity(speed) {
    if (!speed || !speed.active || !speed.duration) return 0;
    const v = 50 / Math.max(0.8, speed.duration);
    return speed.reverse ? v : -v;
  }

  _attachDiscAnimation(track, speed, canvas = null) {
    if (!track) return;
    if (!this._discAnimations) this._discAnimations = new Map();
    let anim = this._discAnimations.get(track);
    if (!anim) {
      anim = {
        track,
        canvas,
        position: 0,
        currentVelocity: 0,
        targetVelocity: 0,
        reverse: Boolean(speed?.reverse),
        lastTimestamp: 0,
        rafId: null,
        resizeObserver: null,
      };
      if (canvas && typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(() => {
          drawFerrarisDiscCanvas(anim.canvas, anim.position, anim.currentVelocity, anim.reverse);
        });
        ro.observe(canvas);
        anim.resizeObserver = ro;
      }
      this._discAnimations.set(track, anim);
    } else if (canvas) {
      anim.canvas = canvas;
    }
    if (anim.canvas) {
      drawFerrarisDiscCanvas(anim.canvas, anim.position, anim.currentVelocity, Boolean(speed?.reverse));
      safeRaf(() => {
        if (anim.canvas) drawFerrarisDiscCanvas(anim.canvas, anim.position, anim.currentVelocity, anim.reverse);
      });
    }
    this._updateDiscAnimation(track, speed);
  }

  _updateDiscAnimation(track, speed) {
    if (!this._discAnimations) return;
    const anim = this._discAnimations.get(track);
    if (!anim) return;
    anim.reverse = Boolean(speed?.reverse);
    anim.targetVelocity = this._calcTargetVelocity(speed);
    if (anim.rafId == null && (anim.targetVelocity !== 0 || Math.abs(anim.currentVelocity) > 0.01)) {
      anim.lastTimestamp = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      anim.rafId = safeRaf((now) => this._stepDiscAnimation(anim, now));
    } else if (anim.canvas) {
      drawFerrarisDiscCanvas(anim.canvas, anim.position, anim.currentVelocity, anim.reverse);
    }
  }

  _stepDiscAnimation(anim, now) {
    if (anim.track && anim.track.isConnected === false) {
      anim.rafId = null;
      return;
    }
    const dt = anim.lastTimestamp ? Math.min((now - anim.lastTimestamp) / 1000, 0.1) : 0.016;
    anim.lastTimestamp = now;

    anim.currentVelocity = simulateDiscPhysics(anim.currentVelocity, anim.targetVelocity, dt, 1.8);

    if (anim.currentVelocity === 0 && anim.targetVelocity === 0) {
      if (anim.canvas) drawFerrarisDiscCanvas(anim.canvas, anim.position, 0, anim.reverse);
      anim.rafId = null;
      return;
    }

    anim.position += anim.currentVelocity * dt;
    while (anim.position <= -50) anim.position += 50;
    while (anim.position > 0) anim.position -= 50;

    if (anim.track) {
      anim.track.style.transform = `translate3d(${anim.position.toFixed(2)}%, 0, 0)`;
    }
    if (anim.canvas) {
      drawFerrarisDiscCanvas(anim.canvas, anim.position, anim.currentVelocity, anim.reverse);
    }
    anim.rafId = safeRaf((nextNow) => this._stepDiscAnimation(anim, nextNow));
  }

  _stopDiscAnimations() {
    if (this._discAnimations) {
      for (const anim of this._discAnimations.values()) {
        if (anim.rafId != null) {
          safeCaf(anim.rafId);
          anim.rafId = null;
        }
        if (anim.resizeObserver) {
          anim.resizeObserver.disconnect();
          anim.resizeObserver = null;
        }
      }
      this._discAnimations.clear();
    }
  }

  _cleanupOrphanedDiscAnimations() {
    if (!this._discAnimations || !this.shadowRoot) return;
    for (const [track, anim] of this._discAnimations.entries()) {
      if (!this.shadowRoot.contains(track)) {
        if (anim.rafId != null) safeCaf(anim.rafId);
        if (anim.resizeObserver) anim.resizeObserver.disconnect();
        this._discAnimations.delete(track);
      }
    }
  }

  async _seedEnergyHistory(entityId, unit, stateClass) {
    if (!entityId || typeof this._hass?.callWS !== "function") return;
    if (!this._seededHistoryEntities) this._seededHistoryEntities = new Set();
    if (!this._historyLoadingEntities) this._historyLoadingEntities = new Set();
    if (this._seededHistoryEntities.has(entityId) || this._historyLoadingEntities.has(entityId)) return;

    this._historyLoadingEntities.add(entityId);
    const endMs = Date.now();
    const startMs = endMs - FERRARIS_HISTORY_LOOKBACK_MS;
    try {
      const result = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: new Date(startMs).toISOString(),
        end_time: new Date(endMs).toISOString(),
        entity_ids: [entityId],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      const entries = Array.isArray(result?.[entityId]) ? result[entityId] : [];
      if (entries.length >= 2) {
        const tempStore = new Map();
        for (const entry of entries) {
          const val = numericState(entry.s ?? entry.state);
          const tsSec = Number(entry.lu ?? entry.lc ?? Date.parse(entry.last_updated ?? entry.last_changed) / 1000);
          if (!Number.isFinite(val) || !Number.isFinite(tsSec)) continue;
          const tsMs = tsSec * 1000;
          estimatePowerFromEnergyChanges(tempStore, entityId, val, unit, {
            sampleTimeMs: tsMs,
            nowMs: tsMs,
            stateClass,
          });
        }
        const seeded = tempStore.get(entityId);
        if (seeded && seeded.samples.length >= 2) {
          if (!this._energyEstimator) this._energyEstimator = new Map();
          const currentLive = this._energyEstimator.get(entityId);
          if (!currentLive || currentLive.samples.length < 2) {
            this._energyEstimator.set(entityId, seeded);
          }
        }
      }
    } catch {
      // Recorder history is optional; live state changes continue to estimate power.
    } finally {
      this._historyLoadingEntities.delete(entityId);
      this._seededHistoryEntities.add(entityId);
      if (this._config && this._hass) this._render();
    }
  }

  _estimatePowerForItem(item, state, rawVal, unit) {
    if (!item?.entity) return null;
    if (isPowerSensor(state)) {
      return extractWatts(state);
    }
    if (!this._energyEstimator) this._energyEstimator = new Map();
    const stateClass = state?.attributes?.state_class || null;
    this._seedEnergyHistory(item.entity, unit, stateClass);
    const rawStamp = Date.parse(state?.last_changed || state?.last_updated || "");
    const sampleTimeMs = Number.isFinite(rawStamp) ? rawStamp : undefined;
    return estimatePowerFromEnergyChanges(this._energyEstimator, item.entity, rawVal, unit, {
      sampleTimeMs,
      nowMs: Date.now(),
      stateClass,
    });
  }

  _render() {
    if (!this._config || !this.shadowRoot) return;
    const cardEl = this.shadowRoot.querySelector("ha-card");
    const showHeader = Boolean(this._config.show_header ?? this._config.show_title ?? true);
    if (cardEl) cardEl.classList.toggle("no-header", !showHeader);

    const title = this._config.title || "Powermesh Zähler";
    const headerEl = this.shadowRoot.querySelector("header h2");
    if (headerEl) headerEl.textContent = title;
    const body = this.shadowRoot.querySelector(".meters-body");
    if (!body) return;

    const items = meterStyleConfig(this._config);
    if (!items.length) {
      body.innerHTML = '<div class="meter-card-empty">Zähler-Sensor in den Karteneinstellungen auswählen.</div>';
      return;
    }

    const language = this._hass?.locale?.language || "de";
    const existingChildren = [...body.children];
    const sections = items.map((item, idx) => {
      const state = this._hass?.states?.[item.entity];
      const style = item.style || "modern";
      const name = item.name || state?.attributes?.friendly_name || item.entity || "Zähler";
      const unit = item.unit || state?.attributes?.unit_of_measurement || "kWh";
      const decimals = item.decimals != null ? item.decimals : 1;
      const rawVal = state && !["unknown", "unavailable"].includes(state.state) ? Number(state.state) : NaN;
      const digits = formatMeterDigits(rawVal, decimals, 6);

      let powerWatts = null;
      let powerEstimated = false;
      const hasExplicitPowerEntity = Boolean(item.disk_power_entity);
      if (hasExplicitPowerEntity) {
        if (this._hass?.states?.[item.disk_power_entity]) {
          powerWatts = extractWatts(this._hass.states[item.disk_power_entity]);
        }
      } else {
        powerWatts = this._estimatePowerForItem(item, state, rawVal, unit);
        powerEstimated = !isPowerSensor(state);
      }
      const speed = ferrarisSpeed(powerWatts);
      speed.estimated = powerEstimated;
      speed.hasPowerValue = powerWatts != null;

      const existing = existingChildren[idx];
      if (
        style === "ferraris" &&
        existing &&
        existing.dataset?.style === "ferraris" &&
        existing.dataset?.entity === item.entity &&
        existing.dataset?.decimals === String(decimals) &&
        digits &&
        existing.querySelectorAll(".ferraris-drum-ribbon").length === digits.digits.length
      ) {
        return this._updateFerraris(existing, item, name, state, digits, speed, unit, rawVal, decimals);
      }

      let section;
      if (style === "ferraris") {
        section = this._renderFerraris(item, name, state, digits, speed, unit, rawVal, decimals);
        section.dataset.decimals = String(decimals);
      } else if (style === "ebz") {
        section = this._renderEbz(item, name, state, digits, speed, unit);
      } else if (style === "emh") {
        section = this._renderEmh(item, name, state, digits, speed, unit);
      } else if (style === "nixie") {
        section = this._renderNixie(item, name, state, digits, unit);
      } else if (style === "vfd") {
        section = this._renderVfd(item, name, state, digits, unit);
      } else {
        section = this._renderModern(item, name, state, digits, speed, unit, language);
      }
      section.dataset.style = style;
      section.dataset.entity = item.entity;

      if (state && item.entity) {
        section.addEventListener("click", () => {
          this.dispatchEvent(new CustomEvent("hass-more-info", {
            detail: { entityId: item.entity },
            bubbles: true,
            composed: true,
          }));
        });
      }
      return section;
    });

    if (sections.some((s, i) => s !== existingChildren[i]) || sections.length !== existingChildren.length) {
      body.replaceChildren(...sections);
      this._cleanupOrphanedDiscAnimations();
    }
  }

  _renderModern(item, name, state, digits, speed, unit, language) {
    const card = el("div", "style-modern");
    const header = el("div", "modern-header");
    header.append(el("span", null, name));
    if (speed.active) {
      const approx = speed.estimated ? "~ " : "";
      const pText = `${speed.power < 0 ? "🌿 " : "⚡ "}${approx}${Math.abs(Math.round(speed.power))} W`;
      const pBadge = el("span", `modern-power-badge${speed.power < 0 ? " export" : ""}`, pText);
      header.append(pBadge);
    }
    const display = el("div", "modern-display");
    const valText = digits ? digits.formatted : "–";
    display.append(el("span", "modern-value", valText), el("span", "modern-unit", unit));
    const meta = el("div", "modern-meta");
    const stamp = state?.last_updated ? formatTime(state.last_updated, language) : "Nicht verfügbar";
    meta.append(el("span", null, `Stand: ${stamp}`));
    card.append(header, display, meta);
    return card;
  }

  _formatFerrarisPowerInfo(item, speed) {
    const isExport = speed.active && speed.power < 0;
    const absW = Math.abs(Math.round(speed.power || 0));
    if (item.disk_power_entity) {
      const text = !speed.active
        ? "0 W · Stillstand"
        : isExport
          ? `–${absW} W · Rücklauf`
          : `${absW} W`;
      return { text, isExport, estimated: false };
    }
    if (speed.active) {
      const text = isExport
        ? `~ –${absW} W · geschätzt`
        : `~ ${absW} W · geschätzt`;
      return { text, isExport, estimated: true };
    }
    return {
      text: speed.hasPowerValue ? "~ 0 W · Stillstand" : "0 W · Stillstand",
      isExport: false,
      estimated: true,
    };
  }

  _renderFerraris(item, name, state, digits, speed, unit, rawVal, decimals) {
    const animate = item.animate_digits ?? this._config.animate_digits ?? true;
    const card = el("div", "style-ferraris");
    const bezel = el("div", "ferraris-bezel");
    const faceplate = el("div", "ferraris-faceplate");
    faceplate.append(el("div", "ferraris-glass-reflection"));

    // 1. Register row: Schutzklasse II & double-circle marks | Odometer + keeper tab | Unit (kWh)
    const registerRow = el("div", "ferraris-register-row");
    const safetyMarks = createFerrarisSvg(
      "0 0 20 42",
      `<rect x="2" y="1.5" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `<rect x="5.5" y="5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<circle cx="10" cy="31" r="7.5" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<circle cx="10" cy="31" r="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/>`,
      "ferraris-safety-marks"
    );

    const registerCol = el("div", "ferraris-register-col");
    const odoHousing = el("div", "ferraris-odometer-housing");
    const drumPositions = computeFerrarisDrumPositions(rawVal, decimals, 6);

    const makeDrumNode = (d, idx, pos) => {
      const drum = el("div", `ferraris-drum ${d.isRed ? "decimal" : "integer"}`);
      drum.dataset.drumIndex = String(idx);
      const num = Number(d.char);
      if (Number.isInteger(num) && num >= 0 && num <= 9 && pos != null) {
        const ribbon = el("div", `ferraris-drum-ribbon${animate ? " animated" : ""}`);
        ribbon.dataset.current = String(Math.floor(pos + 1e-6) % 10);
        ribbon.dataset.pos = String(pos);
        ribbon.append(el("div", "ferraris-digit-cell", "9"));
        for (let digit = 0; digit <= 9; digit++) {
          ribbon.append(el("div", "ferraris-digit-cell", String(digit)));
        }
        ribbon.append(el("div", "ferraris-digit-cell", "0"));
        ribbon.append(el("div", "ferraris-digit-cell", "1"));
        ribbon.style.transform = `translateY(calc(${-pos} * var(--drum-step, 24px)))`;
        drum.append(ribbon);
      } else {
        drum.append(el("div", "ferraris-digit-cell", d.char));
      }
      drum.append(el("div", "ferraris-drum-shade"));
      return drum;
    };

    if (digits) {
      const intList = digits.digits.filter((d) => d.role !== "decimal");
      const decList = digits.digits.filter((d) => d.role === "decimal");

      const intWrap = el("div", `ferraris-drums-int-wrap${decList.length === 0 ? " all-integer" : ""}`);
      const intDrums = el("div", "ferraris-drums");
      intList.forEach((d, i) => {
        const pos = drumPositions ? drumPositions[i] : Number(d.char);
        intDrums.append(makeDrumNode(d, i, pos));
      });
      intWrap.append(intDrums);
      odoHousing.append(intWrap);

      if (decList.length > 0) {
        const decWrap = el("div", "ferraris-drums-dec-wrap");
        decWrap.append(el("span", "ferraris-comma-wedge"));
        const decDrums = el("div", "ferraris-drums");
        decList.forEach((d, j) => {
          const idx = intList.length + j;
          const pos = drumPositions ? drumPositions[idx] : Number(d.char);
          decDrums.append(makeDrumNode(d, idx, pos));
        });
        decWrap.append(decDrums);
        odoHousing.append(decWrap);
      }
    } else {
      const intWrap = el("div", "ferraris-drums-int-wrap all-integer");
      const intDrums = el("div", "ferraris-drums");
      for (let i = 0; i < 6; i++) {
        const drum = el("div", "ferraris-drum integer");
        drum.append(el("div", "ferraris-digit-cell", "–"), el("div", "ferraris-drum-shade"));
        intDrums.append(drum);
      }
      intWrap.append(intDrums);
      odoHousing.append(intWrap);
    }

    registerCol.append(odoHousing, el("div", "ferraris-keeper-tab"));
    registerRow.append(safetyMarks, registerCol, el("span", "ferraris-unit-tag", unit));

    // 2. Nameplate: Brand + Designation + PTB box, divider line, technical ratings
    const nameplate = el("div", "ferraris-nameplate");
    const brandRow = el("div", "ferraris-brand-row");
    const ptbBox = el("div", "ferraris-ptb-box");
    ptbBox.append(el("div", null, "20.14"), el("div", null, "79.02"));
    brandRow.append(
      el("span", "ferraris-brand", "Powermesh"),
      el("span", "ferraris-designation", name),
      ptbBox
    );

    const specsRow = el("div", "ferraris-specs-row");
    specsRow.append(
      el("span", null, "Type E72F"),
      el("span", null, "230 V"),
      el("span", "ferraris-amp-badge", "10(40)A"),
      el("span", null, "50 Hz")
    );
    nameplate.append(brandRow, el("div", "ferraris-rule"), specsRow);

    // 3. Rotor disc window flanked by classic fletched rotation arrow + center index mark
    const rotorSection = el("div", "ferraris-rotor-section");
    const rotorRow = el("div", "ferraris-rotor-row");
    const leftArrow = createFerrarisSvg(
      "0 0 68 14",
      `<polygon points="2,2 22,2 27,7 22,12 2,12 7,7" fill="currentColor"/>` +
      `<line x1="25" y1="7" x2="68" y2="7" stroke="currentColor" stroke-width="2"/>`,
      "ferraris-arrow left"
    );
    const rightArrow = createFerrarisSvg(
      "0 0 68 14",
      `<line x1="0" y1="7" x2="45" y2="7" stroke="currentColor" stroke-width="2"/>` +
      `<polygon points="41,2 66,7 41,12 45,7" fill="currentColor"/>`,
      "ferraris-arrow right"
    );

    const chamber = el("div", `ferraris-chamber${speed.reverse ? " solar-export" : ""}`);
    const win = el("div", "ferraris-window");
    const canvas = el("canvas", "ferraris-disc-canvas");
    canvas.setAttribute("width", "240");
    canvas.setAttribute("height", "13");
    win.append(canvas, el("div", "ferraris-window-glass"));

    const track = el("div", "ferraris-disc-track");
    track.style.setProperty("--disc-duration", `${speed.duration}s`);
    track.style.setProperty("--disc-direction", speed.reverse ? "reverse" : "normal");
    track.style.setProperty("--disc-play-state", speed.active ? "running" : "paused");
    const half1 = el("div", "ferraris-disc-half");
    half1.append(el("div", "ferraris-mark"));
    const half2 = el("div", "ferraris-disc-half");
    half2.append(el("div", "ferraris-mark"));
    track.append(half1, half2);
    win.append(track);
    chamber.append(win);

    rotorRow.append(leftArrow, chamber, rightArrow);
    rotorSection.append(rotorRow, el("div", "ferraris-center-tick"));

    // 4. Bottom row: Serial number + meter constant on left, power info + WEEE/CE marks on right
    const bottomRow = el("div", "ferraris-bottom-row");
    const serialCol = el("div", "ferraris-serial-col");
    const nrLine = el("div", "ferraris-nr-line");
    nrLine.append(el("span", null, "Nr."), el("span", "ferraris-nr-plate", ferrarisSerialNumber(item.entity || name)));
    serialCol.append(
      nrLine,
      el("div", null, "375 U/kWh"),
      el("div", null, "Schltg. 1000")
    );

    const rightCol = el("div", "ferraris-right-col");
    const powerInfo = this._formatFerrarisPowerInfo(item, speed);
    const powerClasses = [
      "ferraris-power-info",
      powerInfo.isExport ? "export" : "",
      powerInfo.estimated ? "estimated" : "",
    ].filter(Boolean).join(" ");
    rightCol.append(el("div", powerClasses, powerInfo.text));

    const compliance = el("div", "ferraris-compliance");
    const weeeBadge = createFerrarisSvg(
      "0 0 22 24",
      `<line x1="2" y1="2" x2="20" y2="20" stroke="currentColor" stroke-width="1.3"/>` +
      `<line x1="20" y1="2" x2="2" y2="20" stroke="currentColor" stroke-width="1.3"/>` +
      `<path d="M6.5 6.5 H15.5 L14.5 17.5 H7.5 Z" fill="none" stroke="currentColor" stroke-width="1.3"/>` +
      `<path d="M5.5 6.5 Q11 4.2 16.5 6.5" fill="none" stroke="currentColor" stroke-width="1.3"/>` +
      `<circle cx="14.2" cy="17.5" r="1.5" fill="currentColor"/>` +
      `<rect x="5" y="21" width="12" height="2.2" fill="currentColor"/>`,
      "ferraris-sticker-badge"
    );
    const ceBadge = createFerrarisSvg(
      "0 0 30 20",
      `<path d="M12.5 4.2 A6 6 0 1 0 12.5 15.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="butt"/>` +
      `<path d="M26.5 4.2 A6 6 0 1 0 26.5 15.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="butt"/>` +
      `<line x1="20.2" y1="10" x2="25.2" y2="10" stroke="currentColor" stroke-width="2.1"/>`,
      "ferraris-sticker-badge"
    );
    compliance.append(weeeBadge, ceBadge);
    rightCol.append(compliance);

    bottomRow.append(serialCol, rightCol);

    faceplate.append(registerRow, nameplate, rotorSection, bottomRow);
    bezel.append(faceplate);
    card.append(bezel);
    this._attachDiscAnimation(track, speed, canvas);
    return card;
  }

  _updateFerraris(existingCard, item, name, state, digits, speed, unit, rawVal, decimals) {
    const animate = item.animate_digits ?? this._config.animate_digits ?? true;
    const desigEl = existingCard.querySelector(".ferraris-designation");
    if (desigEl && desigEl.textContent !== name) desigEl.textContent = name;
    const unitEl = existingCard.querySelector(".ferraris-unit-tag");
    if (unitEl && unitEl.textContent !== unit) unitEl.textContent = unit;

    if (digits) {
      const drums = existingCard.querySelectorAll(".ferraris-drum");
      const drumPositions = computeFerrarisDrumPositions(rawVal, decimals, 6);
      digits.digits.forEach((d, idx) => {
        const drum = drums[idx];
        if (!drum) return;
        const ribbon = drum.querySelector(".ferraris-drum-ribbon");
        const pos = drumPositions ? drumPositions[idx] : Number(d.char);
        if (ribbon && Number.isFinite(pos)) {
          const prevPos = Number(ribbon.dataset.pos ?? pos);
          if (Math.abs(prevPos - pos) >= 0.002) {
            const oldBase = Math.floor(prevPos + 1e-6) % 10;
            const newBase = Math.floor(pos + 1e-6) % 10;
            ribbon.dataset.current = String(newBase);
            ribbon.dataset.pos = String(pos);
            if (animate) {
              ribbon.classList.add("animated");
              if (oldBase === 9 && newBase === 0 && pos < 1) {
                ribbon.style.transform = `translateY(calc(${-(10 + pos)} * var(--drum-step, 24px)))`;
                ribbon.addEventListener("transitionend", () => {
                  ribbon.classList.remove("animated");
                  ribbon.style.transform = `translateY(calc(${-pos} * var(--drum-step, 24px)))`;
                }, { once: true });
              } else {
                ribbon.style.transform = `translateY(calc(${-pos} * var(--drum-step, 24px)))`;
              }
            } else {
              ribbon.classList.remove("animated");
              ribbon.style.transform = `translateY(calc(${-pos} * var(--drum-step, 24px)))`;
            }
          }
        }
      });
    }

    const track = existingCard.querySelector(".ferraris-disc-track");
    if (track) {
      track.style.setProperty("--disc-duration", `${speed.duration}s`);
      track.style.setProperty("--disc-direction", speed.reverse ? "reverse" : "normal");
      track.style.setProperty("--disc-play-state", speed.active ? "running" : "paused");
      this._attachDiscAnimation(track, speed, existingCard.querySelector(".ferraris-disc-canvas"));
    }
    const chamber = existingCard.querySelector(".ferraris-chamber");
    if (chamber) {
      chamber.classList.toggle("solar-export", speed.reverse);
    }
    const info = existingCard.querySelector(".ferraris-power-info");
    if (info) {
      const powerInfo = this._formatFerrarisPowerInfo(item, speed);
      info.textContent = powerInfo.text;
      info.className = [
        "ferraris-power-info",
        powerInfo.isExport ? "export" : "",
        powerInfo.estimated ? "estimated" : "",
      ].filter(Boolean).join(" ");
    }
    return existingCard;
  }

  _renderEbz(item, name, state, digits, speed, unit) {
    const card = el("div", "style-ebz");
    const header = el("div", "ebz-header");
    header.append(el("span", "ebz-brand", "EBZ · DD3 2R06"), el("span", "ebz-sub", name));

    const main = el("div", "ebz-main");
    const port = el("div", "ebz-optical-port");
    port.append(el("div", "ebz-diode"), el("div", "ebz-diode"));

    const lcd = el("div", "ebz-lcd");
    const top = el("div", "ebz-lcd-top");
    const obis = speed.reverse ? "2.8.0" : "1.8.0";
    const valText = digits ? digits.formatted : "–";
    top.append(el("span", "ebz-obis", obis), el("span", "ebz-digits", valText), el("span", "ebz-unit", unit));

    const bottom = el("div", "ebz-lcd-bottom");
    bottom.append(el("span", "ebz-phases", "L1 L2 L3"));
    if (item.disk_power_entity || speed.hasPowerValue) {
      const approx = speed.estimated ? "~" : "";
      const pText = speed.active
        ? `${speed.power < 0 ? "-A " : "+A "}${approx}${Math.abs(Math.round(speed.power))} W`
        : "0 W";
      bottom.append(el("span", `ebz-power${speed.power < 0 ? " export" : ""}`, pText));
    } else {
      bottom.append(el("span", "ebz-power", "+A"));
    }
    lcd.append(top, bottom);
    main.append(port, lcd);

    const footer = el("div", "ebz-specs-footer");
    footer.append(el("span", null, "3x230/400V 50Hz · Cl. A"), el("span", null, "DTA - SMZ"));

    card.append(header, main, footer);
    return card;
  }

  _renderEmh(item, name, state, digits, speed, unit) {
    const card = el("div", "style-emh");
    card.append(el("div", "emh-stripe"));

    const header = el("div", "emh-header");
    header.append(el("span", "emh-logo", "EMH metering"), el("span", "emh-model", `mMe4.0 · ${name}`));

    const main = el("div", "emh-main");
    const optics = el("div", "emh-optics");
    optics.append(el("div", "emh-led"), el("span", "emh-led-label", "10.000 Imp."), el("div", "emh-optical-port", "🔦"));

    const lcd = el("div", "emh-lcd");
    const top = el("div", "emh-lcd-top");
    const obis = speed.reverse ? "2.8.0" : "1.8.0";
    const valText = digits ? digits.formatted : "–";
    const obisWrap = el("div", null);
    obisWrap.append(el("span", "emh-tariff", "T1"), el("span", "emh-obis", obis));
    top.append(obisWrap, el("span", "emh-digits", valText), el("span", "emh-unit", unit));

    const bottom = el("div", "emh-lcd-bottom");
    bottom.append(el("span", null, "L1 L2 L3"));
    if (item.disk_power_entity || speed.hasPowerValue) {
      const approx = speed.estimated ? "~" : "";
      const pText = speed.active
        ? `${speed.power < 0 ? "◀ -P " : "▶ +P "}${approx}${Math.abs(Math.round(speed.power))} W`
        : "P = 0 W";
      bottom.append(el("span", `emh-power${speed.power < 0 ? " export" : ""}`, pText));
    } else {
      bottom.append(el("span", "emh-power", "▶ +P"));
    }
    bottom.append(el("span", "emh-lock", "🔓"));
    lcd.append(top, bottom);
    main.append(optics, lcd);

    const footer = el("div", "emh-specs-footer");
    footer.append(el("span", null, "3x230/400V · 5(60)A · 50Hz"), el("span", null, "ED300L"));

    card.append(header, main, footer);
    return card;
  }

  _renderNixie(item, name, state, digits, unit) {
    const card = el("div", "style-nixie");
    card.append(el("div", "nixie-title", name));
    const display = el("div", "nixie-display");

    if (digits) {
      digits.digits.forEach((d) => {
        if (d.role === "decimal" && d === digits.digits.find((x) => x.role === "decimal")) {
          const dotTube = el("div", "nixie-dot-tube");
          dotTube.append(el("div", "nixie-dot"));
          display.append(dotTube);
        }
        const tube = el("div", "nixie-tube");
        tube.append(el("div", "nixie-tube-glass"), el("div", "nixie-mesh"), el("span", "nixie-digit", d.char));
        display.append(tube);
      });
    } else {
      for (let i = 0; i < 6; i++) {
        const tube = el("div", "nixie-tube");
        tube.append(el("div", "nixie-tube-glass"), el("div", "nixie-mesh"), el("span", "nixie-digit", "–"));
        display.append(tube);
      }
    }
    display.append(el("span", "nixie-unit", unit));
    card.append(display);
    return card;
  }

  _renderVfd(item, name, state, digits, unit) {
    const card = el("div", "style-vfd");
    card.append(el("div", "vfd-grid-overlay"));
    const header = el("div", "vfd-header");
    header.append(el("span", null, name), el("span", null, "VFD 80s"));
    card.append(header);

    const display = el("div", "vfd-display");
    if (digits) {
      digits.digits.forEach((d) => {
        if (d.role === "decimal" && d === digits.digits.find((x) => x.role === "decimal")) {
          display.append(el("div", "vfd-dot"));
        }
        const digitWrap = el("div", "vfd-digit");
        digitWrap.innerHTML = renderVfdDigitSvg(d.char);
        display.append(digitWrap);
      });
    } else {
      for (let i = 0; i < 6; i++) {
        const digitWrap = el("div", "vfd-digit");
        digitWrap.innerHTML = renderVfdDigitSvg("-");
        display.append(digitWrap);
      }
    }
    display.append(el("span", "vfd-unit", unit));
    card.append(display);
    return card;
  }
}


export class PowermeshMeterCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._form = document.createElement("ha-form");
    this._form.schema = [
      { name: "title", selector: { text: {} } },
      { name: "show_header", selector: { boolean: {} } },
      { name: "entity", selector: { entity: { domain: "sensor" } } },
      { name: "name", selector: { text: {} } },
      {
        name: "style",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "ferraris", label: "Retro Ferraris (Rollenzählwerk & Drehscheibe)" },
              { value: "ebz", label: "EBZ Digitalzähler (DD3 / mMe)" },
              { value: "emh", label: "EMH Smart Meter (mMe4.0 / eHZ)" },
              { value: "modern", label: "Modern Clean" },
              { value: "nixie", label: "Nixie Tubes" },
              { value: "vfd", label: "80s Retro VFD / 7-Segment" },
            ],
          },
        },
      },
      {
        name: "disk_power_entity",
        selector: {
          entity: {
            domain: "sensor",
            device_class: ["power"],
          },
        },
      },
      { name: "decimals", selector: { number: { min: 0, max: 3, mode: "box" } } },
      { name: "animate_digits", selector: { boolean: {} } },
    ];
    this._form.computeLabel = ({ name }) => ({
      title: "Kartentitel (optional)",
      show_header: "Kopfbereich mit Titel anzeigen",
      entity: "Zähler-Sensor (z. B. Netzbezug, Solarerzeugung)",
      name: "Bezeichnung / Name",
      style: "Visualisierungs-Stil",
      disk_power_entity: "Momentanleistung für Drehscheibe (optional, sonst aus Zähleränderung geschätzt)",
      decimals: "Nachkommastellen (Standard: 1)",
      animate_digits: "Zahlenwechsel animieren (Rollenzählwerk)",
    })[name] || name;
    this._form.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      this._config = { ...this._config, ...event.detail.value };
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
    });
    this.shadowRoot.append(this._form);
  }

  setConfig(config) {
    this._config = { style: "ferraris", decimals: 1, animate_digits: true, show_header: true, ...config };
    this._form.data = this._config;
  }

  set hass(hass) {
    this._form.hass = hass;
  }
}

if (!customElements.get("powermesh-meter-card")) customElements.define("powermesh-meter-card", PowermeshMeterCard);
if (!customElements.get("powermesh-meter-card-editor")) customElements.define("powermesh-meter-card-editor", PowermeshMeterCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "powermesh-meter-card")) {
  window.customCards.push({
    type: "powermesh-meter-card",
    name: "Powermesh Zähler",
    description: "Multistyle-Zählerkarte (Retro Ferraris, EBZ, EMH, Modern Clean, Nixie, 80s VFD)",
    preview: true,
  });
}






