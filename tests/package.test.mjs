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
    [`${component}/manifest.json`]: '{"domain":"powermesh_energy","version":"0.8.0"}',
    [`${component}/const.py`]: 'VERSION: Final = "0.8.0"\n',
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
  const path = join(work, 'dist/powermesh-energy-homeassistant-0.8.0.zip');
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
  writeFileSync(join(work, component, 'const.py'), 'VERSION: Final = "0.8.0"\n');
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
const { sourceValue } = await import(`data:text/javascript;base64,${Buffer.from(cardSource).toString('base64')}`);
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
