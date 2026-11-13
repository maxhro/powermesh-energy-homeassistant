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
  t.after(() => rmSync(work, { recursive: true }));
  copyFileSync(join(root, 'build-package.ps1'), join(work, 'build-package.ps1'));
  for (const [name, content] of Object.entries({
    [`${component}/manifest.json`]: '{"domain":"powermesh_energy","version":"0.9.3"}',
    [`${component}/const.py`]: 'VERSION: Final = "0.9.3"\n',
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
    encoding: 'utf8', timeout: 30_000,
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
  const path = join(work, 'dist/powermesh-energy-homeassistant-0.9.3.zip');
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
  writeFileSync(join(work, component, 'const.py'), 'VERSION: Final = "0.9.3"\n');
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
const { sourceValue, roleEntities, summedSourceValue, averagedSourceValue, configuredEnergyRoles, bandGeometry, sparklinePath, timelineSegments, numericState, smoothHistory, powerHistoryGeometry } = await import(`data:text/javascript;base64,${Buffer.from(cardSource).toString('base64')}`);
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
  assert.match(cardSource, /multiple: true/);
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
