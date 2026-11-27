// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  ACTIONS,
  BUDGET_DEFAULT,
  BUDGET_MAX,
  BUDGET_MIN,
  BUS_SLOTS,
  REFRESH_DEFAULT,
  REFRESH_MAX,
  REFRESH_MIN,
  SCENE_TRIGGER,
  TRAIN_SLOTS,
} from '../src/constants.js';
import { LANGUAGES, normalizeConfig, watchKeys } from '../src/config.js';
import { readAlerts } from '../src/cta.js';
import { buildDevices } from '../src/devices.js';
import { sceneData } from '../src/app.js';
import { ALERTS_LIVE } from './helpers/setup.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');
const SEMVER = /^\d+\.\d+\.\d+$/;

const ALL = {
  ...Object.fromEntries(TRAIN_SLOTS.map((n) => [`train${n}_station`, `4038${n}`])),
  ...Object.fromEntries(BUS_SLOTS.map((n) => [`bus${n}_stop`, `45${n}`])),
};

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; one version in the four places, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, SEMVER);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-cta:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(pkg.name, 'gladys-cta');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.categories, ['transport']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.countries, ['US']);
  assert.equal(manifest.gladys_version, '>=5.3.0', 'countries need 5.3.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.location, undefined, 'the house location is never asked');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-cta\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300);
  }
  assert.match(manifest.description.en, /^Unofficial\./);
  assert.match(manifest.description.fr, /^Non officiel\./);
});

test('CTA trademark guidelines: CTA is never the first nor the main word of the name', () => {
  assert.doesNotMatch(manifest.name, /^CTA|Tracker|official|authorized/i);
  assert.doesNotMatch(manifest.name, /\bCTA\b/);
  for (const file of ['README.md', 'docs/en.md']) {
    assert.match(read(file), /Data provided by CTA/, file);
    assert.match(read(file), /not affiliated with/i, file);
  }
  assert.match(read('docs/fr.md'), /Données fournies par la CTA/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /not covered by the Apache License/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the configuration matches the code; no key prefixed gladys_; secrets without default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  const expected = ['intro', 'train_key', 'bus_key', 'language', 'refresh_seconds', 'daily_budget'];
  for (const [kind, slots] of [
    ['train', TRAIN_SLOTS],
    ['bus', BUS_SLOTS],
  ]) {
    for (const slot of slots) {
      const keys = watchKeys(kind, slot);
      expected.push(`${kind}${slot}`, keys.name, keys.id, keys.routes);
      assert.equal(fields[keys.id].required, false);
      assert.doesNotMatch(fields[keys.name].placeholder.en, /train\d|bus\d/);
    }
  }
  assert.deepEqual(Object.keys(fields), expected);
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/i);
  for (const key of ['train_key', 'bus_key']) {
    assert.equal(fields[key].type, 'secret');
    assert.equal('default' in fields[key], false);
    assert.equal(fields[key].required, false);
    assert.match(
      fields[key].description.en,
      /kept by Gladys in its database, never shown again, sent only to the CTA/,
    );
    assert.match(
      fields[key].description.fr,
      /gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement à la CTA/,
    );
  }
  assert.equal(fields.refresh_seconds.default, REFRESH_DEFAULT);
  assert.equal(fields.refresh_seconds.min, REFRESH_MIN);
  assert.equal(fields.refresh_seconds.max, REFRESH_MAX);
  assert.equal(fields.daily_budget.default, BUDGET_DEFAULT);
  assert.equal(fields.daily_budget.min, BUDGET_MIN);
  assert.equal(fields.daily_budget.max, BUDGET_MAX);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  const defaults = normalizeConfig({});
  assert.equal(defaults.refreshSeconds, fields.refresh_seconds.default);
  assert.equal(defaults.dailyBudget, fields.daily_budget.default);
  assert.equal(defaults.language, fields.language.default);
  for (const field of manifest.config_schema.filter((f) => f.type === 'select')) {
    assert.ok(
      field.options.some((o) => o.value === field.default),
      field.key,
    );
  }
  // Every placeholder of an id is a valid one.
  assert.deepEqual(
    normalizeConfig({ train1_station: '40380', bus1_stop: '456', bus1_routes: '20' }).errors,
    [],
  );
});

test('actions, scene trigger and handlers agree; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(manifest.actions[0].timeout_seconds >= 35, 'gap + 15 s request + Gladys, for two keys');
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(index.includes('app.connected()'));
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
  assert.deepEqual(
    manifest.scene_triggers.map((s) => s.key),
    [SCENE_TRIGGER],
  );
  const trigger = manifest.scene_triggers[0];
  const device = trigger.fields.find((f) => f.key === 'device');
  assert.equal(device.required, true);
  assert.equal(device.source, 'devices');
  assert.deepEqual(
    trigger.fields.find((f) => f.key === 'major').options.map((o) => o.value),
    ['yes', 'no'],
  );
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const file of ['src/cta.js', 'src/app.js']) {
    const code = read(file).replace(/\/\/.*$/gm, '');
    for (const word of ["'POST'", "'PUT'", "'DELETE'", 'Mozilla']) {
      assert.ok(!code.includes(word), `${file}: never ${word}`);
    }
  }
});

test('the scene data keys are declared (variables and fields), at most 30, flat', () => {
  const trigger = manifest.scene_triggers[0];
  const declared = new Set([...trigger.fields, ...trigger.variables].map((f) => f.key));
  for (const alert of readAlerts(ALERTS_LIVE).alerts) {
    const data = sceneData('ext:cta:train:1-40380', alert);
    for (const key of Object.keys(data)) assert.ok(declared.has(key), key);
    for (const key of declared) assert.ok(key in data, key);
    assert.ok(Object.keys(data).length <= 30);
    for (const value of Object.values(data)) {
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
      if (typeof value === 'number') assert.ok(Number.isFinite(value));
      if (typeof value === 'string') assert.ok(value.length <= 1000);
    }
  }
});

test('the published devices follow the core rules (supported_options, units, NOT NULL)', () => {
  const gladys = createFakeGladys({ selector: 'cta' });
  const devices = buildDevices(gladys, normalizeConfig(ALL));
  assert.equal(devices.length, 8);
  const core = new URL('../../../Gladys/server/utils/constants.js', import.meta.url);
  let unitsByCategory = null;
  if (existsSync(core)) {
    const require = createRequire(core);
    unitsByCategory = require(core.pathname).DEVICE_FEATURE_UNITS_BY_CATEGORY;
  }
  const ids = new Set();
  for (const device of devices) {
    assert.ok(!ids.has(device.external_id));
    ids.add(device.external_id);
    for (const feature of device.features) {
      assert.ok(!ids.has(feature.external_id));
      ids.add(feature.external_id);
      for (const key of ['name', 'min', 'max', 'read_only', 'has_feedback']) {
        assert.notEqual(feature[key], undefined, `${feature.external_id}.${key}`);
        assert.notEqual(feature[key], null, `${feature.external_id}.${key}`);
      }
      const options = feature.supported_options ?? [];
      const values = new Set();
      for (const option of options) {
        assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0 && option.label === option.label.trim());
        assert.ok(Number.isInteger(option.value) || typeof option.value === 'string');
        assert.ok(!values.has(String(option.value)));
        values.add(String(option.value));
      }
      assert.equal(feature.read_only, true);
      assert.notEqual(feature.type, 'binary');
      if (feature.unit && unitsByCategory) {
        assert.ok(unitsByCategory[feature.category]?.includes(feature.unit), feature.external_id);
      }
    }
  }
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Developer License Agreement/);
});

test('the docs say what the data is not, and how it was tested', () => {
  for (const file of ['docs/en.md', 'README.md']) {
    assert.match(read(file), /never tested with a real\s+key/i, file);
  }
  assert.match(read('docs/fr.md'), /jamais été testée avec une vraie\s+clé/i);
});
