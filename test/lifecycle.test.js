// Connections, configurations, Discovery and stops: never a read sooner than
// the interval, never a timer or a request after a stop, a Gladys that fails
// or hangs never holds the reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CtaApp } from '../src/app.js';
import { FEATURES } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { settle, testClock } from './kit/clock.mjs';
import {
  BEGIN,
  CAPTURED_AT,
  D,
  F,
  HOME,
  MINUTE,
  SECOND,
  createApi,
  createdDevices,
  defaultWorld,
  published,
  setup,
  statusEn,
} from './helpers/setup.js';

test('getConfig() failing in connected: retried, spaced out, with the status; then it starts', async (t) => {
  const clock = testClock({ start: CAPTURED_AT });
  const gladys = createFakeGladys({ selector: 'cta', config: HOME, devices: createdDevices(HOME) });
  await gladys.connect();
  let failures = 2;
  const getConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('Gladys busy');
    }
    return getConfig();
  };
  const api = createApi();
  api.clock = clock;
  const quiet = () => {};
  const app = new CtaApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: api.fetch,
  });
  t.after(() => app.stop());
  const job = app.connected();
  await settle(10);
  assert.match(gladys.fake.connectionStatus.message.en, /next try in 5 s/);
  await clock.advance(5 * SECOND);
  await settle(10);
  assert.match(gladys.fake.connectionStatus.message.en, /next try in 10 s/);
  assert.equal(api.calls.length, 0);
  await clock.advance(10 * SECOND);
  await job;
  await clock.advance(BEGIN);
  await settle(10);
  assert.equal(api.count('train'), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a disconnection stops the retry loop and the rounds; nothing after a stop', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.begin();
  const before = s.api.calls.length;
  await s.app.disconnected();
  assert.equal(s.clock.pending, 0, 'no timer left');
  await s.wait(10 * MINUTE);
  assert.equal(s.api.calls.length, before);
  // A stop while a request is out: its answer is dropped, nothing published.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = await setup({
    api: createApi(async (call, api) => {
      await gate;
      return defaultWorld(call, api);
    }),
  });
  await slow.app.start(HOME);
  await slow.wait(0);
  assert.equal(slow.api.open, 1);
  await slow.app.stop();
  release();
  await settle(20);
  assert.equal(slow.clock.pending, 0);
  assert.equal(slow.api.calls.length, 1);
  assert.equal(slow.fake.states.length, 0);
});

test('a reconnection, a saved unchanged configuration, Discovery and the button never read sooner', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.begin();
  assert.equal(s.api.count('train'), 1);
  await s.app.start(HOME);
  await s.app.scan();
  await s.app.testConnection();
  await s.app.disconnected();
  await s.app.connected();
  await s.wait(30 * SECOND);
  assert.equal(s.api.count('train'), 1);
  await s.wait(15 * SECOND);
  assert.equal(s.api.count('train'), 2);
});

test('another station in a slot is another device; the old one is named in the status', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.begin();
  await s.app.start({ ...HOME, train1_station: '40370' });
  await s.wait(BEGIN);
  assert.equal(
    s.api.calls
      .filter((c) => c.kind === 'train')
      .at(-1)
      .params.get('mapid'),
    '40370',
  );
  assert.match(statusEn(s.fake), /Not updated any more .*Clark\/Lake|Not updated any more .*40380/);
  assert.ok(s.fake.discoveredDevices.some((d) => d.external_id === D('train', 1, '40370')));
  // The old device kept its last values; nothing new for it.
  assert.equal(published(s.fake, F('train', 1, '40380', FEATURES.DEPARTURES)).length, 1);
});

test('a Gladys that does not answer a publication never holds the rounds', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.gladys.publishStates = () => new Promise(() => {});
  s.gladys.setConnectionStatus = () => new Promise(() => {});
  // Not awaited: the start itself waits (10 s at most) for the status.
  s.app.start(HOME);
  await s.wait(5 * MINUTE);
  assert.ok(s.api.count('train') >= 5, `${s.api.count('train')} reads`);
});

test('/data that cannot be written: the status says so, the reads go on', async (t) => {
  const store = createMemoryStore();
  store.failSave = true;
  const s = await setup({ store });
  t.after(() => s.app.stop());
  await s.app.start(HOME);
  await s.wait(31 * SECOND);
  assert.equal(s.api.count('train'), 1);
  assert.match(statusEn(s.fake), /could not be written in \/data/);
});

test('/data slow (saves held over a minute): late, not failed; never said as not written, the reads go on', async (t) => {
  const store = createMemoryStore();
  let release;
  store.hold = new Promise((resolve) => (release = resolve));
  const s = await setup({ store });
  t.after(() => {
    store.hold = null;
    release();
    return s.app.stop();
  });
  // Not awaited: the check of /data waits 2 s for its save.
  s.app.start(HOME);
  await s.wait(0);
  await s.wait(5 * SECOND);
  // Late at the start: /data does not tell (the safe side), but nothing failed.
  assert.match(statusEn(s.fake), /does not tell when the CTA was last read/);
  assert.doesNotMatch(statusEn(s.fake), /could not be written/);
  // Rounds at 30 s (the start could not tell) and 90 s.
  await s.wait(100 * SECOND);
  // Every save of the rounds (start, keyed requests, end) was late.
  assert.equal(s.api.count('train'), 2);
  assert.equal(s.api.count('bus'), 2);
  assert.ok(s.lines.some((l) => /Saving \/data is slow/.test(l)));
  assert.doesNotMatch(statusEn(s.fake), /could not be written/);
  // The saves come through at last: nothing to say either.
  release();
  store.hold = null;
  await s.wait(60 * SECOND);
  assert.doesNotMatch(statusEn(s.fake), /could not be written/);
  assert.equal(store.data.quota.train.count, s.api.count('train'));
});

test('a slow save that fails afterwards is a failure, said once it fails; a good save clears it', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.begin();
  assert.doesNotMatch(statusEn(s.fake), /could not be written/);
  const save = s.store.save.bind(s.store);
  let failing = true;
  s.store.save = async (next) => {
    if (!failing) return save(next);
    await new Promise((resolve) => s.clock.timers.setTimeout(resolve, 5 * SECOND));
    throw Object.assign(new Error('I/O error'), { code: 'EIO' });
  };
  await s.wait(1 * MINUTE);
  assert.ok(s.lines.some((l) => /Saving \/data is slow/.test(l)));
  assert.ok(s.lines.some((l) => /Saving \/data failed \(EIO\)/.test(l)));
  assert.match(statusEn(s.fake), /could not be written in \/data/);
  failing = false;
  await s.wait(1 * MINUTE);
  assert.doesNotMatch(statusEn(s.fake), /could not be written/);
});

test('the saves of a round: a failure is said wherever it happens, a late keyed save is not', async (t) => {
  // One save misbehaves, once: the one after the train request (the count of
  // the bus request), or the one after the bus request (the end of the round).
  let mode = null;
  let once = null;
  const held = [];
  const store = createMemoryStore();
  const save = store.save.bind(store);
  store.save = async (data) => {
    const how = once;
    once = null;
    if (how === 'fail') throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
    if (how === 'late') await new Promise((resolve) => held.push(resolve));
    return save(data);
  };
  const api = createApi((call, api) => {
    if (call.kind === 'train' && mode === 'keyed-late') once = 'late';
    if (call.kind === 'train' && mode === 'keyed-fail') once = 'fail';
    if (call.kind === 'bus' && mode === 'end-fail') once = 'fail';
    return defaultWorld(call, api);
  });
  const s = await setup({ store, api });
  t.after(() => {
    for (const resolve of held) resolve();
    return s.app.stop();
  });
  await s.begin();
  assert.doesNotMatch(statusEn(s.fake), /could not be written/);
  // The save of the bus request held over a minute: late, not failed.
  mode = 'keyed-late';
  await s.wait(1 * MINUTE);
  assert.equal(s.api.count('bus'), 2);
  assert.equal(held.length, 1);
  assert.ok(s.lines.some((l) => /Saving \/data is slow/.test(l)));
  assert.doesNotMatch(statusEn(s.fake), /could not be written/);
  // The save of the bus request fails: said.
  mode = 'keyed-fail';
  await s.wait(1 * MINUTE);
  assert.equal(s.api.count('bus'), 3);
  assert.match(statusEn(s.fake), /could not be written in \/data/);
  // Only the save at the end of the round fails: said too.
  mode = 'end-fail';
  await s.wait(1 * MINUTE);
  assert.equal(s.api.count('bus'), 4);
  assert.match(statusEn(s.fake), /could not be written in \/data/);
  // A round whose saves all go through clears it.
  mode = null;
  await s.wait(1 * MINUTE);
  assert.equal(s.api.count('bus'), 5);
  assert.doesNotMatch(statusEn(s.fake), /could not be written/);
});

test('the configuration errors are in the status; no valid watch: no read at all', async (t) => {
  const s = await setup({ config: { train1_station: 'abc', train_key: 'x y' } });
  t.after(() => s.app.stop());
  await s.app.start({ train1_station: 'abc', train_key: 'x y' });
  await s.wait(5 * MINUTE);
  assert.equal(s.api.calls.length, 0);
  assert.equal(s.fake.connectionStatus.connected, false);
  assert.match(statusEn(s.fake), /No valid station or stop/);
  assert.match(statusEn(s.fake), /Field train1_station is not an 'L' station/);
  assert.match(statusEn(s.fake), /Field train_key is not a key of the CTA/);
  assert.ok(!statusEn(s.fake).includes('x y'));
  assert.equal(MINUTE, 60 * SECOND);
});
