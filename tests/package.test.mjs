import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const component = 'custom_components/powermesh_energy';

function fixture(t) {
  const work = join(root, 'tests', `.package-${randomUUID()}`);
  mkdirSync(work);
  t.after(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  copyFileSync(join(root, 'build-package.ps1'), join(work, 'build-package.ps1'));
  for (const [name, content] of Object.entries({
    [`${component}/manifest.json`]: '{"domain":"powermesh_energy","version":"0.9.6"}',
    [`${component}/const.py`]: 'VERSION: Final = "0.9.6"\n',
    [`${component}/__init__.py`]: '',
    [`${component}/translations/de.json`]: '{}',
    [`${component}/frontend/powermesh-energy-card.js`]: 'export const synthetic = true;',
    [`${component}/__pycache__/cached.py`]: 'never package',
    [`${component}/.env`]: 'never package',
    '.env': 'SYNTHETIC_NEVER_READ=1',
    LICENSE: 'Synthetic license fixture',
  })) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), content);
  }
  return work;
}

function run(work, flag) {
  return spawnSync('pwsh', ['-NoProfile', '-File', join(work, 'build-package.ps1'), flag], {
    encoding: 'utf8', timeout: 120_000,
  });
}

function zipNames(path) {
  const bytes = readFileSync(path);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  const names = [];
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28);
    names.push(bytes.subarray(offset + 46, offset + 46 + length).toString());
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return names;
}

test('manual-install ZIP includes exactly component sources and license without caches or secrets', (t) => {
  const work = fixture(t);
  const dry = run(work, '-DryRun');
  assert.equal(dry.status, 0, dry.stderr);
  assert.doesNotMatch(dry.stdout, /__pycache__|SYNTHETIC_NEVER|\.env/);
  assert.equal(existsSync(join(work, 'dist')), false);
  const built = run(work, '-BuildPackage');
  assert.equal(built.status, 0, built.stderr);
  const path = join(work, 'dist/powermesh-energy-homeassistant-0.9.6.zip');
  assert.deepEqual(zipNames(path), [
    `${component}/__init__.py`, `${component}/const.py`, `${component}/frontend/powermesh-energy-card.js`, `${component}/manifest.json`,
    `${component}/translations/de.json`, 'LICENSE',
  ]);
  const original = readFileSync(path);
  assert.notEqual(run(work, '-BuildPackage').status, 0);
  assert.deepEqual(readFileSync(path), original);
});

test('version drift, JSON secret files and links are rejected before output', (t) => {
  const work = fixture(t);
  writeFileSync(join(work, component, 'const.py'), 'VERSION: Final = "1.0.0"\n');
  assert.notEqual(run(work, '-BuildPackage').status, 0);
  writeFileSync(join(work, component, 'const.py'), 'VERSION: Final = "0.9.6"\n');
  const yaml = join(work, component, 'secrets.yaml');
  writeFileSync(yaml, 'token: SYNTHETIC_NEVER\n');
  assert.notEqual(run(work, '-BuildPackage').status, 0);
  rmSync(yaml);
  const secret = join(work, component, 'secrets.json');
  writeFileSync(secret, '{}');
  assert.notEqual(run(work, '-BuildPackage').status, 0);
  rmSync(secret);
  if (process.platform === 'win32') {
    t.diagnostic('Symlink fixture requires additional Windows privileges; symlink rejection is exercised on Unix.');
    return;
  }
  symlinkSync(join(work, 'LICENSE'), join(work, component, 'unsafe.py'));
  assert.notEqual(run(work, '-BuildPackage').status, 0);
  assert.equal(existsSync(join(work, 'dist')), false);
});

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => undefined, define: () => {} };
globalThis.window = { customCards: [] };
const cardSource = readFileSync(join(root, component, 'frontend/powermesh-energy-card.js'), 'utf8');
const {
  sourceValue, signedPowerValue, roleEntities, summedSourceValue, averagedSourceValue,
  configuredEnergyRoles, bandGeometry, sparklinePath, timelineSegments, numericState,
  smoothHistory, powerHistoryGeometry, formatMeterDigits, ferrarisSpeed, meterStyleConfig,
  VFD_SEGMENTS, renderVfdDigitSvg, PowermeshMeterCard, PowermeshMeterCardEditor,
} = await import(`data:text/javascript;base64,${Buffer.from(cardSource).toString('base64')}`);
const now = Date.parse('2026-11-05T12:00:00Z');
const source = (value, unit = 'W', stamp = '2026-11-05T12:00:00Z') => ({
  state: value, attributes: { unit_of_measurement: unit }, last_updated: stamp,
});

test('local energy widget converts units and identifies missing, invalid, signed and stale sources', () => {
  assert.deepEqual(sourceValue(source('1.5', 'kW'), 'solar_power', now), {
    value: 1.5, unit: 'kW', status: 'Gerade aktualisiert', stale: false,
  });
  assert.equal(sourceValue(source('0'), 'grid_import_power', now).value, 0);
  assert.equal(sourceValue(source('85', '%'), 'battery_soc', now).value, 85);
  for (const value of ['unknown', 'unavailable', 'NaN', 'Infinity', '', '0x10']) {
    assert.equal(sourceValue(source(value), 'solar_power', now).value, null);
  }
  assert.equal(sourceValue(undefined, 'solar_power', now).value, null);
  assert.equal(sourceValue(source('-50'), 'grid_import_power', now).status, 'Richtung prüfen');
  assert.equal(sourceValue(source('101', '%'), 'battery_soc', now).value, null);
  assert.equal(sourceValue(source('10', 'kWh'), 'solar_power', now).status, 'Einheit prüfen');
  assert.equal(sourceValue(source('1e308', 'kW'), 'solar_power', now).value, null);
  assert.equal(sourceValue(source('10', 'W', '2026-11-05T12:05:00Z'), 'solar_power', now).value, null);
  assert.equal(sourceValue(source('10', 'W', 'invalid'), 'solar_power', now).value, null);
  const stale = sourceValue(source('10', 'W', '2026-11-05T11:45:00Z'), 'solar_power', now);
  assert.equal(stale.value, 10);
  assert.equal(stale.stale, true);
  assert.match(stale.status, /Veraltet/);
});

test('combined grid and battery sensors split signed power by configured direction', () => {
  assert.deepEqual(signedPowerValue(source('-1.25', 'kW'), 'Einspeisung', 'Netzbezug', true, now), {
    value: 1.25, unit: 'kW', direction: 'Einspeisung', stale: false, status: 'Einspeisung · Gerade aktualisiert',
  });
  assert.deepEqual(signedPowerValue(source('850'), 'Einspeisung', 'Netzbezug', true, now), {
    value: 850, unit: 'W', direction: 'Netzbezug', stale: false, status: 'Netzbezug · Gerade aktualisiert',
  });
  assert.deepEqual(signedPowerValue(source('-0.6', 'kW'), 'Entladen', 'Laden', false, now), {
    value: 600, unit: 'W', direction: 'Laden', stale: false, status: 'Laden · Gerade aktualisiert',
  });
  assert.equal(signedPowerValue(source('0'), 'Einspeisung', 'Netzbezug', true, now).direction, 'Ausgeglichen');
  assert.equal(signedPowerValue(source('4', '%'), 'Laden', 'Entladen', true, now).status, 'Einheit prüfen');
  assert.equal(signedPowerValue(source('NaN'), 'Laden', 'Entladen', true, now).status, 'Wert ungültig');
});

test('energy card shows only configured roles, including unavailable sources', () => {
  assert.deepEqual(configuredEnergyRoles({}, {}).map(([role]) => role), []);
  assert.deepEqual(configuredEnergyRoles({}, { solar_power: 'sensor.solar' }).map(([role]) => role), ['solar_power']);
  assert.deepEqual(configuredEnergyRoles({}, { solar_power: ['sensor.solar', 'sensor.solar_roof'] }).map(([role]) => role), ['solar_power']);
  assert.deepEqual(roleEntities({ solar_power: 'sensor.solar' }, {}, 'solar_power'), ['sensor.solar']);
  assert.deepEqual(roleEntities({ solar_power: ['sensor.solar', 'sensor.solar_roof'] }, {}, 'solar_power'), ['sensor.solar', 'sensor.solar_roof']);
  assert.deepEqual(roleEntities({ solar_power: [] }, { solar_power: ['sensor.solar'] }, 'solar_power'), ['sensor.solar']);
  assert.deepEqual(configuredEnergyRoles({ grid_import_power: 'sensor.missing' }, { battery_soc: 'sensor.battery' }).map(([role]) => role), ['grid_import_power', 'battery_soc']);
  assert.equal(sourceValue(undefined, 'grid_import_power', now).status, 'Nicht verfügbar');
});

test('power areas can be summed across W and kW without hiding incomplete sources', () => {
  const total = summedSourceValue([source('1500', 'W'), source('0.5', 'kW')], 'solar_power', now);
  assert.deepEqual(total, { value: 2, unit: 'kW', status: '2 Quellen', stale: false });
  assert.deepEqual(summedSourceValue([source('1500'), undefined], 'grid_import_power', now), {
    value: null, status: 'Quellen prüfen · 1/2 verfügbar',
  });
  assert.match(cardSource, /name: "sum_by_area", selector: \{ boolean: \{\} \}/);
  assert.match(cardSource, /integration: "powermesh_energy"/);
  assert.match(cardSource, /device_class: role === "battery_soc" \? \["battery"\] : \["power"\]/);
  assert.match(cardSource, /unit_of_measurement: role === "battery_soc" \? \["%"\] : \["W", "kW"\]/);
  assert.match(cardSource, /multiple: true/);
  assert.match(cardSource, /\["grid_power_entity", "battery_power_entity"\]/);
  assert.match(cardSource, /name: "grid_negative_is_export"/);
  assert.match(cardSource, /name: "battery_negative_is_discharge"/);
  assert.match(cardSource, /negativeIsNegative: this\._config\.grid_negative_is_export \?\? true/);
  assert.match(cardSource, /negativeIsNegative: this\._config\.battery_negative_is_discharge \?\? true/);
});

test('battery percentages can be averaged without summing or hiding incomplete sources', () => {
  assert.deepEqual(averagedSourceValue([source('60', '%'), source('80', '%')], 'battery_soc', now), {
    value: 70, unit: '%', status: 'Mittelwert aus 2 Sensoren', stale: false,
  });
  assert.deepEqual(averagedSourceValue([source('60', '%'), undefined], 'battery_soc', now), {
    value: null, status: 'Quellen prüfen · 1/2 verfügbar',
  });
  assert.match(cardSource, /name: "average_battery_soc", selector: \{ boolean: \{\} \}/);
});

test('energy card aligns metrics and offers a time-weighted optional power history', () => {
  assert.match(cardSource, /\.metric \{ display: flex; flex-direction: column/);
  assert.match(cardSource, /name: "show_history"/);
  assert.match(cardSource, /name: "history_hours"/);
  assert.match(cardSource, /name: "smoothing_minutes"/);
  assert.deepEqual(smoothHistory([[0, 0], [5, 10], [10, 20]], 10), [[0, 0], [5, 0], [10, 5]]);
  assert.deepEqual(smoothHistory([[0, 0], [5, 10]], 0), [[0, 0], [5, 10]]);
  assert.deepEqual(smoothHistory([[0, 100], [5, NaN], [8, 20], [10, 40]], 10), [[0, 100], [5, NaN], [8, 20], [10, 20]]);
  assert.deepEqual(smoothHistory([[0, 0], [5, 10], [20, 20]], 10), [[0, 0], [5, 0], [20, 10]]);
  const chart = powerHistoryGeometry([
    { role: 'solar_power', label: 'Solar', color: '#b57912', unit: 'kW', points: [[0, 1], [3600, 2]] },
    { role: 'grid_import_power', label: 'Netzbezug', color: '#22766d', unit: 'W', points: [[0, 500], [3600, 1000]] },
  ], 0, 3600, 360, 156);
  assert.equal(chart.maxValue, 2000);
  assert.equal(chart.lines.length, 2);
  assert.equal(chart.grid.length, 5);
  assert.equal(chart.ticks.length, 3);
  assert.match(chart.lines[0].path, /^M42 /);
  const held = powerHistoryGeometry([
    { role: 'solar_power', unit: 'W', points: [[-100, 500]] },
  ], 0, 3600, 360, 156);
  assert.match(held.lines[0].path, /^M42 .*H352$/);
  assert.equal(powerHistoryGeometry([{ unit: '%', points: [[0, 50]] }], 0, 3600, 360, 156), null);
  assert.equal(powerHistoryGeometry([], 0, 3600, 360, 156), null);
});

test('anomaly widget positions the learned band and flags values outside it', () => {
  const inside = bandGeometry(100, 80, 120);
  assert.deepEqual(inside, { bandStart: 25, bandEnd: 75, marker: 50, outside: false });
  const above = bandGeometry(200, 80, 120);
  assert.equal(above.outside, true);
  assert.equal(above.marker, 100);
  assert.ok(above.bandEnd < above.marker);
  assert.equal(bandGeometry(Number.NaN, 80, 120).marker, null);
  assert.equal(bandGeometry(100, 120, 80), null);
  assert.equal(bandGeometry(100, undefined, 80), null);
});

test('optional history chart draws a step line with gaps and the learned band', () => {
  const chart = sparklinePath([[-10, 10], [50, 20], [60, Number.NaN], [80, 10]], 0, 100, 100, 10, 10, 20);
  assert.deepEqual(chart, { path: 'M0 9.5 H50 V0.5 H60 M80 9.5 H100', bandTop: 0.5, bandBottom: 9.5 });
  assert.equal(sparklinePath([[10, Number.NaN]], 0, 100, 100, 10), null);
  assert.equal(sparklinePath([[10, 5]], 100, 100, 100, 10), null);
  assert.equal(sparklinePath([[10, 5]], 0, 100, 100, 10).bandTop, null);
  assert.equal(numericState('12.5'), 12.5);
  for (const value of ['unavailable', 'unknown', '', '0x10', 'Infinity', null]) assert.ok(Number.isNaN(numericState(value)));
  const raw = [[0, 0], [30, 100], [60, 0]];
  const rawPath = sparklinePath(raw, 0, 60, 100, 50, 20, 80).path;
  const smoothedPath = sparklinePath(smoothHistory(raw, 60), 0, 60, 100, 50, 20, 80).path;
  assert.notEqual(smoothedPath, rawPath);
  assert.match(cardSource, /smoothHistory\(history\.series\[monitor\.entity_id\] \|\| \[\]/);
  assert.match(cardSource, /name: "smoothing_minutes", selector: \{ number: \{ min: 0, max: 60/);
});

test('optional timeline positions findings in the window and keeps open findings until now', () => {
  const start = Date.parse('2026-11-01T00:00:00Z') / 1000;
  const end = start + 100 * 3600;
  const iso = (hours) => new Date((start + hours * 3600) * 1000).toISOString();
  assert.deepEqual(timelineSegments([
    { since: iso(25), resolved: iso(50), type: 'deviation', category: 'behavior' },
    { since: iso(90), type: 'no_data', category: 'data_quality' },
    { since: iso(-20), resolved: iso(-10), type: 'deviation', category: 'behavior' },
    { since: 'invalid', type: 'deviation', category: 'behavior' },
  ], start, end), [
    { left: 25, width: 25, type: 'deviation', category: 'behavior', open: false },
    { left: 90, width: 10, type: 'no_data', category: 'data_quality', open: true },
  ]);
  assert.deepEqual(timelineSegments([], end, start), []);
});

test('meter card digit formatter splits integer and decimal drums and flags red decimal drum', () => {
  const formatted = formatMeterDigits(12345.67, 1, 6);
  assert.equal(formatted.intStr, '012345');
  assert.equal(formatted.decStr, '7');
  assert.equal(formatted.formatted, '012345,7');
  assert.equal(formatted.digits.length, 7);
  for (let i = 0; i < 6; i++) {
    assert.equal(formatted.digits[i].isRed, false);
    assert.equal(formatted.digits[i].role, 'integer');
  }
  assert.equal(formatted.digits[6].isRed, true);
  assert.equal(formatted.digits[6].role, 'decimal');
  assert.equal(formatted.digits[6].char, '7');
  assert.equal(formatted.digits[6].progress, 0.7);

  const integerOnly = formatMeterDigits(42, 0, 5);
  assert.equal(integerOnly.formatted, '00042');
  assert.equal(integerOnly.digits.length, 5);
  assert.ok(integerOnly.digits.every((d) => !d.isRed));
  assert.equal(integerOnly.digits[4].progress, 0);

  assert.equal(formatMeterDigits(null), null);
  assert.equal(formatMeterDigits('invalid'), null);
  assert.equal(formatMeterDigits(NaN), null);
});

test('ferraris wheel speed scales dynamically with power and reverses on export', () => {
  const high = ferrarisSpeed(3000);
  assert.equal(high.active, true);
  assert.equal(high.reverse, false);
  assert.equal(high.duration, 0.8);

  const standby = ferrarisSpeed(80);
  assert.equal(standby.active, true);
  assert.equal(standby.reverse, false);
  assert.equal(standby.duration, 30);

  const moderate = ferrarisSpeed(1000);
  assert.equal(moderate.duration, 2.4);

  const exportPower = ferrarisSpeed(-1200);
  assert.equal(exportPower.active, true);
  assert.equal(exportPower.reverse, true);
  assert.equal(exportPower.duration, 2.0);

  const zero = ferrarisSpeed(0);
  assert.equal(zero.active, false);
  assert.equal(zero.duration, 0);

  const trivial = ferrarisSpeed(1.2);
  assert.equal(trivial.active, false);

  assert.equal(ferrarisSpeed(null).active, false);
  assert.equal(ferrarisSpeed(NaN).active, false);
});

test('meter card configuration normalizes single and multi entity setups', () => {
  const single = meterStyleConfig({
    entity: 'sensor.stromzaehler_bezug',
    name: 'Netzbezug',
    style: 'ferraris',
    disk_power_entity: 'sensor.leistung',
    decimals: 1,
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].entity, 'sensor.stromzaehler_bezug');
  assert.equal(single[0].style, 'ferraris');

  const multi = meterStyleConfig({
    entities: [
      { entity: 'sensor.meter1', style: 'ferraris' },
      { entity: 'sensor.meter2', style: 'ebz' },
      { entity: 'sensor.meter3', style: 'emh' },
      'sensor.meter4',
    ],
  });
  assert.equal(multi.length, 4);
  assert.equal(multi[0].style, 'ferraris');
  assert.equal(multi[1].style, 'ebz');
  assert.equal(multi[2].style, 'emh');
  assert.equal(multi[3].entity, 'sensor.meter4');

  assert.deepEqual(meterStyleConfig(null), []);
  assert.deepEqual(meterStyleConfig({}), []);
});

test('vfd 7-segment digit map and svg renderer produce all segments', () => {
  assert.deepEqual(VFD_SEGMENTS['0'], ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(VFD_SEGMENTS['8'], ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(VFD_SEGMENTS['-'], ['g']);
  const svg0 = renderVfdDigitSvg('0');
  assert.match(svg0, /class="seg on".*points="4,2 18,2 16,5 6,5"/);
  assert.match(svg0, /class="seg off".*points="4,19 6,17 16,17 18,19 16,21 6,21"/);
});

test('powermesh-meter-card provides editor element, stub config and registers in customCards', () => {
  assert.equal(typeof PowermeshMeterCard.getConfigElement, 'function');
  assert.equal(typeof PowermeshMeterCard.getStubConfig, 'function');
  const stub = PowermeshMeterCard.getStubConfig({
    states: {
      'sensor.grid_total': { attributes: { device_class: 'energy', unit_of_measurement: 'kWh' }, entity_id: 'sensor.grid_total' },
      'sensor.grid_power': { attributes: { device_class: 'power', unit_of_measurement: 'W' }, entity_id: 'sensor.grid_power' },
    },
  });
  assert.equal(stub.entity, 'sensor.grid_total');
  assert.equal(stub.disk_power_entity, 'sensor.grid_power');
  assert.equal(stub.style, 'ferraris');
  assert.equal(stub.animate_digits, true);
  assert.match(cardSource, /value:\s*"ebz"/);
  assert.match(cardSource, /value:\s*"emh"/);
  assert.match(cardSource, /animate_digits/);
  assert.match(cardSource, /ferraris-drum-ribbon/);
  assert.match(cardSource, /type:\s*"powermesh-meter-card"/);
  assert.match(cardSource, /name:\s*"Powermesh Zähler"/);
  assert.match(cardSource, /customElements\.define\("powermesh-meter-card", PowermeshMeterCard\)/);
  assert.match(cardSource, /customElements\.define\("powermesh-meter-card-editor", PowermeshMeterCardEditor\)/);
});
