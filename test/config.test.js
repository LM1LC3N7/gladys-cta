// The configuration read strictly: a refused field is named, never echoed;
// a key is never echoed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, readNumber, readRoutes } from '../src/config.js';
import { configErrors } from '../src/i18n.js';

test('defaults; the watches in order, trains then buses', () => {
  const c = normalizeConfig({
    bus2_stop: ' 0456 ',
    train3_station: '30074',
    train1_station: 40380,
    train_key: ' abcdef12345678 ',
  });
  assert.equal(c.language, 'en');
  assert.equal(c.refreshSeconds, 60);
  assert.equal(c.dailyBudget, 10000);
  assert.deepEqual(c.keys, { train: 'abcdef12345678', bus: null });
  assert.deepEqual(
    c.watches.map((w) => `${w.kind}${w.slot}:${w.id}`),
    ['train1:40380', 'train3:30074', 'bus2:456'],
  );
  assert.deepEqual(c.errors, []);
});

test('numbers are plain decimals in range; blank is the default, never 0', () => {
  assert.equal(readNumber(''), null);
  assert.equal(readNumber('  '), null);
  assert.ok(Number.isNaN(readNumber('1e3')));
  assert.ok(Number.isNaN(readNumber('0x10')));
  assert.equal(normalizeConfig({ refresh_seconds: '' }).refreshSeconds, 60);
  for (const bad of ['29', '601', '45.5', 'abc', '1e2']) {
    const c = normalizeConfig({ refresh_seconds: bad });
    assert.equal(c.refreshSeconds, 60, bad);
    assert.deepEqual(c.errors, [{ field: 'refresh_seconds', code: 'refresh' }], bad);
  }
  for (const bad of ['499', '100001', '1000.5']) {
    const c = normalizeConfig({ daily_budget: bad });
    assert.equal(c.dailyBudget, 10000, bad);
    assert.deepEqual(c.errors, [{ field: 'daily_budget', code: 'budget' }]);
  }
  assert.equal(normalizeConfig({ daily_budget: '100000' }).dailyBudget, 100000);
});

test('ids: a station 4xxxx or a platform 3xxxx; a bus stop in digits', () => {
  for (const bad of ['4038', '50380', '40380a', '40 380', '../1', '4038\u00000']) {
    const c = normalizeConfig({ train1_station: bad });
    assert.equal(c.watches.length, 0, bad);
    assert.equal(c.errors[0].code, 'station_invalid');
  }
  for (const bad of ['45a', '1234567', '-1', '4.5']) {
    const c = normalizeConfig({ bus1_stop: bad });
    assert.equal(c.watches.length, 0, bad);
    assert.equal(c.errors[0].code, 'stop_invalid');
  }
});

test('routes: train lines by id or name, bus designators upper-cased, bounded', () => {
  assert.deepEqual(readRoutes('train', 'red, Brown;g,GREEN,pink'), {
    routes: ['Red', 'Brn', 'G', 'Pink'],
  });
  assert.deepEqual(readRoutes('train', 'Silver'), { error: 'train_route_invalid' });
  assert.deepEqual(readRoutes('bus', 'x9, 20 ,j14'), { routes: ['X9', '20', 'J14'] });
  assert.deepEqual(readRoutes('bus', '20-A'), { error: 'routes_invalid' });
  assert.deepEqual(readRoutes('bus', '1,2,3,4,5,6,7,8,9'), { error: 'routes_too_many' });
});

test('a refused key or name is named, never echoed; a refused key is no key', () => {
  const secret = 'abc def-ghi!12345';
  const c = normalizeConfig({
    train_key: secret,
    bus_key: 'short',
    train1_station: '40380',
    train1_name: 'Home\u0007',
  });
  assert.deepEqual(c.keys, { train: null, bus: null });
  const text = JSON.stringify([c, configErrors(c.errors)]);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes('short'));
  assert.deepEqual(
    c.errors.map((e) => `${e.field}:${e.code}`),
    ['train_key:key_invalid', 'bus_key:key_invalid', 'train1_name:name_invalid'],
  );
});
