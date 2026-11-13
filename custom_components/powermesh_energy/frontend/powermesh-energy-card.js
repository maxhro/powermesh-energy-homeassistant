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
        const value = numericState(item.s ?? item.state);
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
    const sources = roles.filter(([role]) => role !== "battery_soc").flatMap(([role, label, , color]) =>
      roleEntities(this._config, configured, role).map((entity) => {
        const state = this._hass.states[entity];
        return { role, label: `${label}: ${state?.attributes?.friendly_name || entity}`, color, entity };
      }),
    ).filter((source) => this._hass.states[source.entity]);
    if (this._config.show_history && sources.length) this._loadPowerHistory(sources);
    const children = configuredEnergyRoles(this._config, configured).flatMap(([role, label, icon, color]) => {
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
      { name: "entity", selector: { entity: { domain: "sensor" } } },
      ...roles.map(([role]) => ({ name: role, selector: { entity: { domain: "sensor", multiple: true } } })),
      { name: "stale_after", selector: { number: { min: 1, max: 1440, mode: "box", unit_of_measurement: "min" } } },
      { name: "sum_by_area", selector: { boolean: {} } },
      { name: "average_battery_soc", selector: { boolean: {} } },
      { name: "show_history", selector: { boolean: {} } },
      { name: "history_hours", selector: { number: { min: 1, max: 48, mode: "box", unit_of_measurement: "h" } } },
      { name: "smoothing_minutes", selector: { number: { min: 0, max: 60, mode: "box", unit_of_measurement: "min" } } },
    ];
    this._form.computeLabel = ({ name }) => ({
      title: "Titel", entity: "Lokale Energieübersicht", stale_after: "Veraltet nach", sum_by_area: "Leistung je Bereich summieren", average_battery_soc: "Akkustände mitteln",
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
    this._config = { show_history: false, history_hours: 6, smoothing_minutes: 0, sum_by_area: false, average_battery_soc: false, ...config, ...rolesConfig };
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

const ANOMALY_DEFAULTS = { show_monitors: true, show_recent: true, show_history: false, history_hours: 6, show_learning_bar: false, show_timeline: false, timeline_days: 7 };
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
    const geometry = sparklinePath(history.series[monitor.entity_id] || [], history.start, history.end, SPARK_WIDTH, SPARK_HEIGHT,
      monitor.kind === "baseline" ? monitor.band_low : NaN, monitor.kind === "baseline" ? monitor.band_high : NaN);
    if (!geometry) return el("span", "spark-note", "Keine Werte im Zeitraum.");
    const chart = svg("svg", { class: "spark", viewBox: `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`, preserveAspectRatio: "none", role: "img",
      "aria-label": `Verlauf der letzten ${this._config.history_hours} Stunden${geometry.bandTop != null ? " mit Normalbereich" : ""}` });
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
      { name: "show_timeline", selector: { boolean: {} } },
      { name: "timeline_days", selector: { number: { min: 1, max: 30, mode: "box", unit_of_measurement: "d" } } },
    ];
    this._form.computeLabel = ({ name }) => ({
      title: "Titel", entity: "Offene Auffälligkeiten", show_monitors: "Überwachte Sensoren zeigen", show_recent: "Beendete Auffälligkeiten zeigen",
      show_learning_bar: "Lernfortschritt als Balken", show_history: "Verlaufsdiagramm mit Normalbereich", history_hours: "Verlaufszeitraum",
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