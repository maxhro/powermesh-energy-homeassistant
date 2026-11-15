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
        .history-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 12px; margin: 0 0 8px; }
        .history-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
        .history-caption, .history-empty { color: var(--secondary-text-color); font-size: 12px; }
        .energy-chart { display: block; width: 100%; height: 156px; overflow: visible; }
        .energy-grid { stroke: var(--divider-color); stroke-width: 1; vector-effect: non-scaling-stroke; }
        .energy-axis { fill: var(--secondary-text-color); font-size: 10px; }
        .energy-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
        .history-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 4px; }
        .history-legend-item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--secondary-text-color); font-size: 12px; }
        .history-legend-swatch { width: 12px; height: 3px; flex: none; }
        @media (max-width: 480px) { .history-section { padding-inline: 12px; } .energy-chart { height: 140px; } }
        @media (prefers-reduced-motion: no-preference) { .metric { transition: background-color 120ms; } }
      </style>
      <ha-card><header><ha-icon icon="mdi:home-lightning-bolt-outline"></ha-icon><h2></h2><span class="local">Lokal</span></header><div class="values"></div><div class="history"></div></ha-card>`;
  }

  static getConfigElement() { return document.createElement("powermesh-energy-card-editor"); }

  static getStubConfig(hass) {
    const entity = Object.values(hass.states).find((state) => state.state === "local" && state.attributes?.roles)?.entity_id;
    return entity ? { entity } : {};
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
    const key = `${hours}|${sources.map((item) => item.entity).sort().join(",")}`;
    if (this._historyLoading || (this._historyKey === key && Date.now() - this._historyAt < HISTORY_REFRESH_MS)) return;
    this._historyLoading = true;
    const end = Date.now();
    const start = end - hours * 3600000;
    try {
      const entityIds = [...new Set(sources.map((item) => item.entity))];
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
    const heading = el("div", "history-heading");
    heading.append(el("h3", null, "Leistungsverlauf"));
    const smoothing = this._config.smoothing_minutes;
    const caption = `Letzte ${this._config.history_hours} h${smoothing ? ` · geglättet ${smoothing} min` : ""}`;
    heading.append(el("span", "history-caption", caption));
    section.append(heading);
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
    const geometry = powerHistoryGeometry(series, this._powerHistory.start, this._powerHistory.end, 360, 156, smoothing * 60, language);
    if (!geometry) {
      section.append(el("div", "history-empty", "Keine Werte im gewählten Zeitraum."));
      return section;
    }
    const chart = svg("svg", { class: "energy-chart", viewBox: "0 0 360 156", preserveAspectRatio: "none", role: "img", "aria-label": `Leistungsverlauf der letzten ${this._config.history_hours} Stunden` });
    geometry.grid.forEach((line) => {
      chart.append(svg("line", { class: "energy-grid", x1: geometry.left, x2: geometry.right, y1: line.y, y2: line.y }));
      const label = svg("text", { class: "energy-axis", x: geometry.left - 5, y: line.y + 3, "text-anchor": "end" });
      label.textContent = `${line.label} ${line.unit}`;
      chart.append(label);
    });
    geometry.ticks.forEach((tick) => {
      chart.append(svg("line", { class: "energy-grid", x1: tick.x, x2: tick.x, y1: geometry.top, y2: geometry.bottom, opacity: 0.45 }));
      const label = svg("text", { class: "energy-axis", x: tick.x, y: 151, "text-anchor": tick.x === geometry.left ? "start" : tick.x === geometry.right ? "end" : "middle" });
      label.textContent = tick.label;
      chart.append(label);
    });
    geometry.lines.forEach((line) => chart.append(svg("path", { class: "energy-line", d: line.path, stroke: line.color })));
    const legend = el("div", "history-legend");
    geometry.lines.forEach((line) => {
      const item = el("span", "history-legend-item");
      const swatch = el("span", "history-legend-swatch");
      swatch.style.backgroundColor = line.color;
      item.append(swatch, document.createTextNode(line.label));
      legend.append(item);
    });
    section.append(chart, legend);
    return section;
  }

  render() {
    if (!this._config || !this._hass) return;
    const focusedRole = this.shadowRoot.activeElement?.dataset.key;
    this.shadowRoot.querySelector("h2").textContent = this._config.title || "Powermesh Energie";
    const configured = this._hass.states[this._config.entity]?.attributes?.roles || {};
    const combinedGrid = Boolean(this._config.grid_power_entity);
    const sources = roles.filter(([role]) => role !== "battery_soc" && !(combinedGrid && ["grid_import_power", "grid_export_power"].includes(role))).flatMap(([role, label, , color]) =>
      roleEntities(this._config, configured, role).map((entity) => {
        const state = this._hass.states[entity];
        return { role, label: `${label}: ${state?.attributes?.friendly_name || entity}`, color, entity };
      }),
    ).filter((source) => this._hass.states[source.entity]);
    if (combinedGrid && this._hass.states[this._config.grid_power_entity]) {
      const entity = this._config.grid_power_entity;
      const name = this._hass.states[entity].attributes?.friendly_name || entity;
      const negativeIsExport = this._config.grid_negative_is_export ?? true;
      sources.push(
        { role: "grid_import_power", label: `Netzbezug: ${name}`, color: "#22766d", entity, signedDirection: negativeIsExport ? "positive" : "negative" },
        { role: "grid_export_power", label: `Einspeisung: ${name}`, color: "#b34f55", entity, signedDirection: negativeIsExport ? "negative" : "positive" },
      );
    }
    if (this._config.battery_power_entity && this._hass.states[this._config.battery_power_entity]) {
      const entity = this._config.battery_power_entity;
      const name = this._hass.states[entity].attributes?.friendly_name || entity;
      const negativeIsDischarge = this._config.battery_negative_is_discharge ?? true;
      sources.push(
        { role: "battery_charge_power", label: `Laden: ${name}`, color: "#427a3b", entity, signedDirection: negativeIsDischarge ? "positive" : "negative" },
        { role: "battery_discharge_power", label: `Entladen: ${name}`, color: "#5974a5", entity, signedDirection: negativeIsDischarge ? "negative" : "positive" },
      );
    }
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

class PowermeshEnergyCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._form = document.createElement("ha-form");
    this._form.schema = [
      { name: "title", selector: { text: {} } },
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
      title: "Titel", entity: "Lokale Energieübersicht", stale_after: "Veraltet nach", sum_by_area: "Leistung je Bereich summieren", average_battery_soc: "Akkustände mitteln",
      grid_power_entity: "Kombinierter Netzsensor (ersetzt getrennte Sensoren)", grid_negative_is_export: "Negative Netzwerte bedeuten Einspeisung",
      battery_power_entity: "Batterieleistung (Laden/Entladen)", battery_negative_is_discharge: "Negative Batteriewerte bedeuten Entladen",
      show_history: "Leistungsverlauf anzeigen", history_hours: "Verlaufszeitraum", smoothing_minutes: "Glättung (0 = aus)",
    })[name] || roles.find(([role]) => role === name)?.[1] || name;
    this._form.addEventListener("value-changed", (event) => {
      event.stopPropagation();
      this._config = { ...this._config, ...event.detail.value };
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
    });
    this.shadowRoot.append(this._form);
  }
  setConfig(config) {
    const rolesConfig = Object.fromEntries(roles.flatMap(([role]) => {
      const selected = config[role];
      return selected == null ? [] : [[role, typeof selected === "string" ? [selected] : selected]];
    }));
    this._config = { show_history: false, history_hours: 6, smoothing_minutes: 0, sum_by_area: false, average_battery_soc: false, grid_negative_is_export: true, battery_negative_is_discharge: true, ...config, ...rolesConfig };
    this._form.data = this._config;
  }
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
  if (!(end > start) || !series.length) return null;
  const left = 42;
  const right = width - 8;
  const top = 8;
  const bottom = height - 24;
  const plotWidth = right - left;
  const plotHeight = bottom - top;
  const normalized = series.map((item) => {
    const factor = item.unit === "kW" ? 1000 : item.unit === "W" ? 1 : NaN;
    const points = item.points.filter(([time]) => time <= end)
      .map(([time, value]) => [time, Number.isFinite(value) && value >= 0 ? value * factor : NaN]);
    const smoothed = smoothHistory(points, smoothingSeconds);
    const visible = smoothed.filter(([time]) => time >= start);
    const previous = smoothed.findLast(([time]) => time < start);
    if (previous && (!visible.length || visible[0][0] > start)) visible.unshift([start, previous[1]]);
    return { ...item, points: visible };
  }).filter((item) => item.points.some(([, value]) => Number.isFinite(value)));
  if (!normalized.length) return null;
  const values = normalized.flatMap((item) => item.points.map(([, value]) => value).filter(Number.isFinite));
  const rawMax = values.reduce((maximum, value) => Math.max(maximum, value), 0);
  const roughStep = (rawMax || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const fraction = roughStep / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
  const maxValue = Math.max(step, Math.ceil(rawMax / step) * step);
  const x = (time) => round1(left + Math.min(1, Math.max(0, (time - start) / (end - start))) * plotWidth);
  const y = (value) => round1(bottom - Math.min(1, Math.max(0, value / maxValue)) * plotHeight);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = maxValue * (4 - index) / 4;
    return { y: round1(top + plotHeight * index / 4), label: new Intl.NumberFormat("de", { maximumFractionDigits: 1 }).format(value >= 1000 ? value / 1000 : value), unit: value >= 1000 ? "kW" : "W" };
  });
  const ticks = [0, 0.5, 1].map((fraction) => {
    const time = start + (end - start) * fraction;
    return { x: round1(left + plotWidth * fraction), label: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(time * 1000) };
  });
  const lines = normalized.map((item) => {
    const points = item.points.filter(([time]) => time >= start && time <= end);
    const path = [];
    let open = false;
    for (const [time, value] of points) {
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
  return lines.length ? { left, right, top, bottom, grid, ticks, lines, maxValue } : null;
}

/** Step-line SVG path (values hold until the next change) with optional normal-range band; NaN values are gaps. */
export function sparklinePath(points, start, end, width, height, low, high) {
  const finite = points.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  if (!finite.length || !(end > start)) return null;
  const band = Number.isFinite(low) && Number.isFinite(high) && high >= low;
  let min = Math.min(...finite.map(([, v]) => v), ...(band ? [low] : []));
  let max = Math.max(...finite.map(([, v]) => v), ...(band ? [high] : []));
  if (max === min) { max += 1; min -= 1; }
  const pad = (max - min) * 0.05;
  min -= pad;
  max += pad;
  const x = (t) => round1(Math.min(1, Math.max(0, (t - start) / (end - start))) * width);
  const y = (v) => round1((1 - (v - min) / (max - min)) * height);
  const parts = [];
  let open = false;
  for (const [t, v] of points) {
    if (!Number.isFinite(t)) continue;
    if (!Number.isFinite(v)) {
      if (open) parts.push(`H${x(t)}`);
      open = false;
    } else if (!open) {
      parts.push(`M${x(t)} ${y(v)}`);
      open = true;
    } else {
      parts.push(`H${x(t)} V${y(v)}`);
    }
  }
  if (open) parts.push(`H${x(end)}`);
  return { path: parts.join(" "), bandTop: band ? y(high) : null, bandBottom: band ? y(low) : null };
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

const ANOMALY_DEFAULTS = { show_monitors: true, show_recent: true, show_history: false, history_hours: 6, smoothing_minutes: 5, show_learning_bar: false, show_timeline: false, timeline_days: 7 };
const HISTORY_REFRESH_MS = 300000;
const SPARK_WIDTH = 300;
const SPARK_HEIGHT = 48;

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
        .progress { grid-column: 1 / -1; height: 6px; border-radius: 3px; background: var(--secondary-background-color); overflow: hidden; }
        .progress > div { height: 100%; background: var(--info-color, #22766d); }
        .spark { grid-column: 1 / -1; display: block; width: 100%; height: 48px; }
        .spark .spark-band { fill: color-mix(in srgb, var(--success-color, #427a3b) 22%, transparent); }
        .spark .spark-line { fill: none; stroke: var(--primary-color); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
        .spark-note { grid-column: 1 / -1; color: var(--secondary-text-color); font-size: 11px; }
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
    return entity ? { entity } : {};
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

  _sparkline(monitor) {
    const history = this._history;
    if (!history || this._historyKey?.split("|")[1]?.split(",").includes(monitor.entity_id) !== true) {
      return el("span", "spark-note", "Verlauf wird geladen …");
    }
    if (history.error) return el("span", "spark-note", "Verlauf nicht verfügbar.");
    const points = smoothHistory(history.series[monitor.entity_id] || [], (this._config.smoothing_minutes ?? 0) * 60);
    const geometry = sparklinePath(points, history.start, history.end, SPARK_WIDTH, SPARK_HEIGHT,
      monitor.kind === "baseline" ? monitor.band_low : NaN, monitor.kind === "baseline" ? monitor.band_high : NaN);
    if (!geometry) return el("span", "spark-note", "Keine Werte im Zeitraum.");
    const chart = svg("svg", { class: "spark", viewBox: `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`, preserveAspectRatio: "none", role: "img",
      "aria-label": `Verlauf der letzten ${this._config.history_hours} Stunden${this._config.smoothing_minutes ? `, geglättet ${this._config.smoothing_minutes} min` : ""}${geometry.bandTop != null ? " mit Normalbereich" : ""}` });
    if (geometry.bandTop != null) {
      chart.append(svg("rect", { class: "spark-band", x: 0, y: geometry.bandTop, width: SPARK_WIDTH, height: Math.max(0.5, geometry.bandBottom - geometry.bandTop) }));
    }
    chart.append(svg("path", { class: "spark-line", d: geometry.path }));
    return chart;
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
    if (this._config.show_history) row.append(this._sparkline(monitor));
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
      title: "Titel", entity: "Offene Auffälligkeiten", show_monitors: "Überwachte Sensoren zeigen", show_recent: "Beendete Auffälligkeiten zeigen",
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


export class PowermeshMeterCard extends HTMLElement {
  constructor() {
    super();
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
        .meter-card-empty { padding: 24px 16px; text-align: center; color: var(--secondary-text-color); font-size: 14px; }

        .style-modern { background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #e0e0e0); border-radius: 8px; padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
        .modern-header { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--secondary-text-color); }
        .modern-display { display: flex; align-items: baseline; gap: 8px; font-variant-numeric: tabular-nums; }
        .modern-value { font-size: 34px; font-weight: 700; line-height: 1.1; color: var(--primary-text-color); letter-spacing: -0.5px; }
        .modern-unit { font-size: 16px; font-weight: 600; color: var(--secondary-text-color); }
        .modern-meta { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--secondary-text-color); border-top: 1px solid var(--divider-color, #eee); padding-top: 8px; margin-top: 4px; }
        .modern-power-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; background: var(--secondary-background-color); font-weight: 500; }
        .modern-power-badge.export { color: var(--success-color, #10b981); }

        .style-ferraris { background: radial-gradient(ellipse at 50% 15%, #2d2e32 0%, #17181a 60%, #0d0e10 100%); border: 2px solid #3d3e42; border-radius: 12px; padding: 16px 18px 20px; box-shadow: inset 0 1px 1px rgba(255,255,255,0.18), inset 0 -3px 12px rgba(0,0,0,0.8), 0 6px 16px rgba(0,0,0,0.4); position: relative; color: #e5e5e5; display: flex; flex-direction: column; align-items: center; gap: 14px; user-select: none; cursor: pointer; }
        .ferraris-screws { position: absolute; top: 8px; left: 8px; right: 8px; bottom: 8px; pointer-events: none; }
        .screw { position: absolute; width: 10px; height: 10px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #888 0%, #444 60%, #222 100%); box-shadow: inset 0 1px 1px rgba(255,255,255,0.3), 0 1px 2px rgba(0,0,0,0.6); }
        .screw::after { content: ""; position: absolute; top: 4.5px; left: 1.5px; width: 7px; height: 1px; background: #111; box-shadow: 0 1px 0 rgba(255,255,255,0.2); transform: rotate(35deg); }
        .screw.tl { top: 0; left: 0; }
        .screw.tr { top: 0; right: 0; }
        .screw.bl { bottom: 0; left: 0; }
        .screw.br { bottom: 0; right: 0; }
        .ferraris-plate { text-align: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; letter-spacing: 1px; }
        .ferraris-brand { font-size: 13px; font-weight: 800; color: #ffb74d; text-shadow: 0 1px 2px rgba(0,0,0,0.8); margin-bottom: 2px; }
        .ferraris-type { font-size: 9px; letter-spacing: 1.5px; color: #a0a0a0; text-transform: uppercase; }
        .ferraris-specs { font-size: 9px; letter-spacing: 0.5px; color: #888; margin-top: 2px; }
        .ferraris-odometer-housing { background: #000; border: 2px solid #2a2a2c; border-radius: 6px; padding: 5px 8px; box-shadow: inset 0 4px 10px rgba(0,0,0,0.95), 0 1px 2px rgba(255,255,255,0.1); display: inline-flex; align-items: center; gap: 2px; }
        .ferraris-drums { display: flex; gap: 1.5px; background: #111; padding: 2px; border-radius: 4px; }
        .ferraris-drum { width: 22px; height: 34px; position: relative; overflow: hidden; border-radius: 2px; box-shadow: inset 0 0 2px rgba(0,0,0,0.5); font-family: "Courier New", Courier, monospace; font-size: 22px; font-weight: 800; line-height: 34px; text-align: center; }
        .ferraris-drum.integer { background-color: #f7f3e8; color: #111; }
        .ferraris-drum.decimal { background-color: #c62828; color: #fff; }
        .ferraris-drum-ribbon { display: flex; flex-direction: column; position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
        .ferraris-drum-ribbon.animated { transition: transform 0.6s cubic-bezier(0.2, 0.8, 0.3, 1); }
        .ferraris-digit-cell { height: 34px; line-height: 34px; text-align: center; flex: none; }

        .ferraris-drum-shade { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; background-image: linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.08) 25%, transparent 45%, transparent 55%, rgba(0,0,0,0.1) 75%, rgba(0,0,0,0.65) 100%); box-shadow: inset 0 1px 1px rgba(255,255,255,0.15); }
        .ferraris-separator { color: #fff; font-size: 20px; font-weight: bold; padding: 0 1px; }
        .ferraris-unit-tag { color: #ff3d00; font-weight: 800; font-size: 13px; padding-left: 6px; letter-spacing: 0.5px; }
        .ferraris-chamber { width: 90%; max-width: 280px; background: #080809; border: 2px solid #222326; border-radius: 6px; padding: 6px 10px; box-shadow: inset 0 3px 8px rgba(0,0,0,0.9); display: flex; flex-direction: column; align-items: center; gap: 6px; transition: box-shadow 0.3s ease; }
        .ferraris-chamber.solar-export { box-shadow: inset 0 0 14px rgba(16, 185, 129, 0.4), inset 0 3px 8px rgba(0,0,0,0.9); border-color: rgba(16, 185, 129, 0.5); }
        .ferraris-window { width: 100%; height: 24px; position: relative; overflow: hidden; border-radius: 4px; background: #111; box-shadow: inset 0 2px 4px rgba(0,0,0,0.8); }
        .ferraris-window-glass { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 2; background: linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 40%, rgba(0,0,0,0.3) 100%); border: 1px solid rgba(255,255,255,0.08); }
        .ferraris-disc-track { position: absolute; top: 0; left: 0; width: 200%; height: 100%; display: flex; animation: ferraris-spin var(--disc-duration, 0s) linear infinite var(--disc-direction, normal); animation-play-state: var(--disc-play-state, paused); }
        .ferraris-disc-half { width: 50%; height: 100%; position: relative; background: repeating-linear-gradient(90deg, #8c8d91 0px, #8c8d91 4px, #58595d 5px, #d1d2d6 9px, #707175 14px); }
        .ferraris-mark { position: absolute; top: 0; bottom: 0; left: 45%; width: 8px; background: #e53935; box-shadow: 0 0 4px #e53935; }
        @keyframes ferraris-spin { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .ferraris-power-info { font-size: 11px; color: #aaa; display: flex; align-items: center; gap: 6px; }
        .ferraris-power-info.export { color: #34d399; }

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
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Ungültige Kartenkonfiguration");
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  _render() {
    if (!this._config || !this.shadowRoot) return;
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

      let speed = { duration: 0, reverse: false, active: false, power: 0 };
      if (item.disk_power_entity && this._hass?.states?.[item.disk_power_entity]) {
        const pState = this._hass.states[item.disk_power_entity];
        const pVal = Number(pState.state);
        if (Number.isFinite(pVal)) {
          const pUnit = pState.attributes?.unit_of_measurement;
          const watts = pUnit === "kW" ? pVal * 1000 : pVal;
          speed = ferrarisSpeed(watts);
        }
      }

      const existing = existingChildren[idx];
      if (
        style === "ferraris" &&
        existing &&
        existing.dataset?.style === "ferraris" &&
        existing.dataset?.entity === item.entity &&
        digits &&
        existing.querySelectorAll(".ferraris-drum-ribbon").length === digits.digits.length
      ) {
        return this._updateFerraris(existing, item, name, state, digits, speed, unit);
      }

      let section;
      if (style === "ferraris") {
        section = this._renderFerraris(item, name, state, digits, speed, unit);
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
    }
  }

  _renderModern(item, name, state, digits, speed, unit, language) {
    const card = el("div", "style-modern");
    const header = el("div", "modern-header");
    header.append(el("span", null, name));
    if (speed.active) {
      const pText = `${speed.power < 0 ? "🌿 " : "⚡ "}${Math.abs(Math.round(speed.power))} W`;
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
  _renderFerraris(item, name, state, digits, speed, unit) {
    const animate = item.animate_digits ?? this._config.animate_digits ?? true;
    const card = el("div", "style-ferraris");

    const screws = el("div", "ferraris-screws");
    ["tl", "tr", "bl", "br"].forEach((pos) => screws.append(el("div", `screw ${pos}`)));

    const plate = el("div", "ferraris-plate");
    plate.append(
      el("div", "ferraris-brand", "POWERMESH · WECHSELSTROMZÄHLER"),
      el("div", "ferraris-type", name),
      el("div", "ferraris-specs", "10(40) A · 230 V · 50 Hz · 375 U/kWh")
    );

    const odoHousing = el("div", "ferraris-odometer-housing");
    const drums = el("div", "ferraris-drums");
    if (digits) {
      digits.digits.forEach((d, idx) => {
        if (d.role === "decimal" && d === digits.digits.find((x) => x.role === "decimal")) {
          drums.append(el("span", "ferraris-separator", ","));
        }
        const drum = el("div", `ferraris-drum ${d.isRed ? "decimal" : "integer"}`);
        drum.dataset.drumIndex = String(idx);
        const num = Number(d.char);
        if (Number.isInteger(num) && num >= 0 && num <= 9) {
          const ribbon = el("div", `ferraris-drum-ribbon${animate ? " animated" : ""}`);
          ribbon.dataset.current = String(num);
          for (let digit = 0; digit <= 9; digit++) {
            ribbon.append(el("div", "ferraris-digit-cell", String(digit)));
          }
          ribbon.append(el("div", "ferraris-digit-cell", "0"));
          const progress = d.progress || 0;
          ribbon.style.transform = `translateY(-${(num + progress) * 34}px)`;
          drum.append(ribbon);
        } else {
          drum.append(el("div", "ferraris-digit-cell", d.char));
        }
        drum.append(el("div", "ferraris-drum-shade"));
        drums.append(drum);
      });
    } else {
      for (let i = 0; i < 6; i++) {
        const drum = el("div", "ferraris-drum integer");
        drum.append(el("div", "ferraris-digit-cell", "–"));
        drum.append(el("div", "ferraris-drum-shade"));
        drums.append(drum);
      }
    }
    odoHousing.append(drums, el("span", "ferraris-unit-tag", unit));

    const chamber = el("div", `ferraris-chamber${speed.reverse ? " solar-export" : ""}`);
    const win = el("div", "ferraris-window");
    win.append(el("div", "ferraris-window-glass"));

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

    if (item.disk_power_entity) {
      let powerText;
      if (!speed.active) {
        powerText = "0 W · Stillstand";
      } else if (speed.power < 0) {
        powerText = `🌿 –${Math.abs(Math.round(speed.power))} W (Einspeisung)`;
      } else {
        powerText = `⚡ ${Math.round(speed.power)} W (Bezug)`;
      }
      const info = el("div", `ferraris-power-info${speed.power < 0 ? " export" : ""}`, powerText);
      chamber.append(info);
    }

    card.append(screws, plate, odoHousing, chamber);
    return card;
  }

  _updateFerraris(existingCard, item, name, state, digits, speed, unit) {
    const animate = item.animate_digits ?? this._config.animate_digits ?? true;
    if (digits) {
      const drums = existingCard.querySelectorAll(".ferraris-drum");
      digits.digits.forEach((d, idx) => {
        const drum = drums[idx];
        if (!drum) return;
        const ribbon = drum.querySelector(".ferraris-drum-ribbon");
        const num = Number(d.char);
        if (ribbon && Number.isInteger(num)) {
          const oldVal = Number(ribbon.dataset.current ?? 0);
          if (oldVal !== num) {
            ribbon.dataset.current = String(num);
            const progress = d.progress || 0;
            if (animate) {
              ribbon.classList.add("animated");
              if (oldVal === 9 && num === 0) {
                ribbon.style.transform = `translateY(-${(10 + progress) * 34}px)`;
                ribbon.addEventListener("transitionend", () => {
                  ribbon.classList.remove("animated");
                  ribbon.style.transform = `translateY(-${progress * 34}px)`;
                }, { once: true });
              } else {
                ribbon.style.transform = `translateY(-${(num + progress) * 34}px)`;
              }
            } else {
              ribbon.classList.remove("animated");
              ribbon.style.transform = `translateY(-${(num + progress) * 34}px)`;
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
    }
    const chamber = existingCard.querySelector(".ferraris-chamber");
    if (chamber) {
      chamber.classList.toggle("solar-export", speed.reverse);
      const info = chamber.querySelector(".ferraris-power-info");
      if (item.disk_power_entity) {
        const powerText = !speed.active ? "0 W · Stillstand" : speed.power < 0 ? `🌿 –${Math.abs(Math.round(speed.power))} W (Einspeisung)` : `⚡ ${Math.round(speed.power)} W (Bezug)`;
        if (info) {
          info.textContent = powerText;
          info.className = `ferraris-power-info${speed.power < 0 ? " export" : ""}`;
        } else {
          chamber.append(el("div", `ferraris-power-info${speed.power < 0 ? " export" : ""}`, powerText));
        }
      } else if (info) {
        info.remove();
      }
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
    if (item.disk_power_entity) {
      const pText = speed.active
        ? `${speed.power < 0 ? "-A " : "+A "}${Math.abs(Math.round(speed.power))} W`
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
    if (item.disk_power_entity) {
      const pText = speed.active
        ? `${speed.power < 0 ? "◀ -P " : "▶ +P "}${Math.abs(Math.round(speed.power))} W`
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
      entity: "Zähler-Sensor (z. B. Netzbezug, Solarerzeugung)",
      name: "Bezeichnung / Name",
      style: "Visualisierungs-Stil",
      disk_power_entity: "Momentanleistung für Drehscheibe (optional)",
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
    this._config = { style: "ferraris", decimals: 1, animate_digits: true, ...config };
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






