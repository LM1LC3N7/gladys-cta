// The guards toward the CTA: the daily budget of each key (counted before
// each request, kept in /data, per Chicago day), a refused key never sent
// again on its own, the pauses, the restart pace, and the secrets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FEATURES } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import {
  BEGIN,
  BUS_KEY,
  CAPTURED_AT,
  F,
  HOME,
  HOUR,
  MINUTE,
  SECOND,
  TRAIN_KEY,
  busDoc,
  createApi,
  defaultWorld,
  json,
  published,
  setup,
  statusEn,
  trainError,
} from './helpers/setup.js';

const T = (key) => F('train', 1, '40380', key);
const B = (key) => F('bus', 1, '456', key);
const TODAY = '2026-11-27';

test('each keyed request is counted in /data before it leaves', async (t) => {
  const store = createMemoryStore();
  const counts = [];
  const api = createApi((call, a) => {
    if (call.kind !== 'alerts') counts.push([call.kind, store.data?.quota?.[call.kind]?.count]);
    return defaultWorld(call, a);
  });
  const s = await setup({ store, api });
  t.after(() => s.app.stop());
  await s.begin();
  await s.wait(60 * SECOND);
  assert.deepEqual(counts, [
    ['train', 1],
    ['bus', 1],
    ['train', 2],
    ['bus', 2],
  ]);
  assert.equal(store.data.quota.train.day, TODAY);
  // The key itself is nowhere in /data: a salted 8-bit print only.
  assert.match(store.data.quota.train.key, /^[0-9a-f]{2}$/);
});

test('a spent budget stops the key until the next Chicago day; the count survives a restart', async (t) => {
  const config = { ...HOME, daily_budget: '500', refresh_seconds: '600' };
  // 470 requests already sent today with this key (a previous run).
  const probe = await setup({ config });
  probe.app.load();
  const print = probe.app.keyPrint(TRAIN_KEY);
  const salt = probe.app.persisted.salt;
  await probe.app.stop();
  const store = createMemoryStore({
    salt,
    lastAttemptAt: CAPTURED_AT - HOUR,
    quota: { train: { day: TODAY, count: 499, key: print } },
  });
  const s = await setup({ store, config });
  t.after(() => s.app.stop());
  await s.begin();
  await s.wait(10 * MINUTE);
  // One request left: sent; the next round finds the budget spent.
  assert.equal(s.api.count('train'), 1);
  assert.equal(store.data.quota.train.count, 500);
  assert.match(statusEn(s.fake), /daily budget of the key is spent/);
  assert.match(statusEn(s.fake), /Train Tracker key: 500 of 500 requests today/);
  // The buses have their own key and budget.
  assert.equal(s.api.count('bus'), 2);
  // At the next Chicago midnight (06:00 UTC), a new day.
  const midnight = Date.parse('2026-11-28T06:00:00Z');
  await s.wait(midnight - s.clock.now() + 11 * MINUTE);
  assert.equal(s.api.count('train'), 2);
  assert.equal(store.data.quota.train.day, '2026-11-28');
  assert.equal(store.data.quota.train.count, 1);
});

test('the interval is stretched to fit 90 % of the budget', async (t) => {
  const config = {
    ...HOME,
    train2_station: '40370',
    train3_station: '40360',
    train4_station: '30074',
    daily_budget: '1000',
    refresh_seconds: '30',
  };
  const s = await setup({ config });
  t.after(() => s.app.stop());
  await s.begin();
  // 4 stations: 4 x 86400 / 900 = 384 s.
  assert.equal(s.app.interval, 384 * SECOND);
  assert.match(statusEn(s.fake), /Reads every 384 s \(not 30 s\) to fit the daily budget/);
  await s.wait(24 * HOUR);
  const today = s.api.calls.filter(
    (c) => c.kind === 'train' && c.wall < Date.parse('2026-11-28T06:00:00Z'),
  );
  assert.ok(today.length <= 900, `${today.length} train requests`);
});

test('a refused Train Tracker key: never sent again on its own; the buses go on', async (t) => {
  const store = createMemoryStore();
  const api = createApi((call, a) =>
    call.kind === 'train'
      ? trainError(a.clock.now(), 101, 'Invalid API key')
      : defaultWorld(call, a),
  );
  const s = await setup({ store, api });
  t.after(() => s.app.stop());
  await s.begin();
  await s.wait(30 * MINUTE);
  assert.equal(s.api.count('train'), 1);
  assert.equal(s.api.count('bus'), 31);
  assert.match(statusEn(s.fake), /refused the API key/);
  assert.match(store.data.refused.train, /^[0-9a-f]{2}$/);
  // A restart: still refused (the print in /data), nothing sent.
  const again = await setup({ store, api: createApi(api.world) });
  t.after(() => again.app.stop());
  await again.begin();
  await again.wait(5 * MINUTE);
  assert.equal(again.api.count('train'), 0);
  // A new key: tried at once.
  await again.app.start({ ...HOME, train_key: 'ffff0000ffff0000' });
  await again.wait(BEGIN + 60 * SECOND);
  assert.equal(again.api.count('train'), 1);
});

test('the button retries a refused key once, 30 s apart; a success lifts the refusal', async (t) => {
  let refuse = true;
  const api = createApi((call, a) =>
    call.kind === 'train' && refuse ? trainError(a.clock.now(), 101) : defaultWorld(call, a),
  );
  const s = await setup({ api });
  t.after(() => s.app.stop());
  await s.begin();
  assert.equal(s.api.count('train'), 1);
  // Too soon after the refused request: nothing sent.
  await s.app.testConnection();
  assert.equal(s.api.count('train'), 1);
  await s.wait(60 * SECOND);
  const failed = s.app.testConnection();
  await s.wait(2 * SECOND);
  const message = await failed;
  assert.equal(s.api.count('train'), 2);
  assert.match(message.en, /refused the API key/);
  await s.wait(60 * SECOND);
  refuse = false;
  const ok = s.app.testConnection();
  await s.wait(2 * SECOND);
  await ok;
  assert.equal(s.api.count('train'), 3);
  assert.deepEqual(published(s.fake, T(FEATURES.DEPARTURES)), [2]);
  await s.wait(60 * SECOND);
  assert.equal(s.api.count('train'), 4, 'the rounds read the key again');
  // Without a refused key, the button never reads.
  await s.app.testConnection();
  assert.equal(s.api.count('train'), 4);
});

test('"daily limit exceeded" pauses that key until the next Chicago day', async (t) => {
  const store = createMemoryStore();
  const api = createApi((call, a) =>
    call.kind === 'bus'
      ? busDoc(null, [{ msg: 'Transaction limit for current day has been exceeded.' }])
      : defaultWorld(call, a),
  );
  const s = await setup({ store, api });
  t.after(() => s.app.stop());
  await s.begin();
  assert.equal(store.data.pause.bus.kind, 'quota');
  // 05:15 in Chicago: until 00:05 the next day.
  assert.equal(store.data.pause.bus.until, Date.parse('2026-11-28T06:05:00Z'));
  assert.match(
    statusEn(s.fake),
    /Bus Tracker key: The CTA says the daily limit of the key is reached; paused until Nov 28, 00:05 CT/,
  );
  await s.wait(18 * HOUR);
  assert.equal(s.api.count('bus'), 1);
  assert.equal(s.api.count('train'), 18 * 60 + 1);
  await s.wait(HOUR);
  assert.equal(s.api.count('bus'), 2);
});

test('a 429 pauses that service only, doubled; a 5xx too; kept in /data', async (t) => {
  const store = createMemoryStore();
  let mode = 429;
  const api = createApi((call, a) => {
    if (call.kind !== 'train' || !mode) return defaultWorld(call, a);
    return json({}, { status: mode, date: a.clock.now() });
  });
  const s = await setup({ store, api });
  t.after(() => s.app.stop());
  await s.begin();
  assert.equal(store.data.pause.train.kind, 'rate');
  await s.wait(20 * MINUTE);
  const at = s.api.calls.filter((c) => c.kind === 'train').map((c) => c.at);
  assert.equal(at.length, 4);
  for (const [i, minutes] of [2, 4, 8].entries()) {
    assert.ok(at[i + 1] - at[i] >= minutes * MINUTE, `gap ${i}`);
    assert.ok(at[i + 1] - at[i] <= (minutes + 1) * MINUTE + SECOND, `gap ${i}`);
  }
  assert.equal(s.api.count('bus'), 21);
  assert.equal(store.data.pause.train.level429, 4);
  mode = 503;
  await s.wait(30 * MINUTE);
  assert.equal(store.data.pause.train.kind, 'server');
  assert.ok(store.data.pause.train.level5xx >= 2);
  mode = 0;
  await s.wait(2 * HOUR);
  assert.equal(store.data.pause.train, undefined);
  assert.ok(published(s.fake, T(FEATURES.DEPARTURES)).length > 0);
  assert.ok(published(s.fake, B(FEATURES.DEPARTURES)).length >= 150);
});

test('a 401 or 403 HTTP status is never a key refusal', async (t) => {
  const store = createMemoryStore();
  const api = createApi((call, a) =>
    call.kind === 'train'
      ? json('Forbidden', { status: 403, date: a.clock.now() })
      : defaultWorld(call, a),
  );
  const s = await setup({ store, api });
  t.after(() => s.app.stop());
  await s.begin();
  assert.equal(store.data.refused.train ?? null, null);
  assert.equal(store.data.pause.train.kind, 'http');
  assert.match(statusEn(s.fake), /unexpected answer from the CTA \(HTTP 403\)/i);
});

test('a restart never reads sooner than the interval; /data future or unreadable waits 30 s', async (t) => {
  const store = createMemoryStore({ lastAttemptAt: CAPTURED_AT - 20 * SECOND });
  const s = await setup({ store });
  t.after(() => s.app.stop());
  await s.app.start(HOME);
  await s.wait(39 * SECOND);
  assert.equal(s.api.calls.length, 0);
  await s.wait(2 * SECOND);
  assert.equal(s.api.count('train'), 1);
  for (const st of [
    createMemoryStore({ lastAttemptAt: CAPTURED_AT + HOUR }),
    createMemoryStore(undefined, { status: 'unreadable' }),
  ]) {
    const r = await setup({ store: st });
    await r.app.start(HOME);
    await r.wait(29 * SECOND);
    assert.equal(r.api.calls.length, 0);
    await r.wait(2 * SECOND);
    assert.equal(r.api.count('train'), 1);
    await r.app.stop();
  }
});

test('an unreadable /data is never overwritten', async (t) => {
  const store = createMemoryStore(undefined, { status: 'unreadable' });
  const s = await setup({ store });
  t.after(() => s.app.stop());
  await s.app.start(HOME);
  await s.wait(2 * MINUTE);
  assert.equal(store.saves, 0);
  assert.match(statusEn(s.fake), /unreadable: left untouched/);
});

test('the keys never reach the logs, /data, the status nor Gladys', async (t) => {
  const store = createMemoryStore();
  let n = 0;
  const api = createApi((call, a) => {
    n += 1;
    if (n === 1) return 'network';
    if (call.kind === 'train' && n === 4) return trainError(a.clock.now(), 101);
    return defaultWorld(call, a);
  });
  const s = await setup({ store, api });
  t.after(() => s.app.stop());
  await s.begin();
  await s.wait(3 * MINUTE);
  await s.app.testConnection();
  const everything = JSON.stringify([
    s.lines,
    store.data,
    s.fake.connectionStatuses,
    s.fake.states,
    s.fake.discoveredDevices,
    s.fake.sceneEvents,
  ]);
  for (const key of [TRAIN_KEY, BUS_KEY]) {
    assert.ok(!everything.includes(key));
    assert.ok(!everything.includes(key.slice(0, 8)));
  }
  assert.ok(s.api.calls.some((c) => c.params.get('key') === TRAIN_KEY));
  // The alerts never carry a key.
  assert.ok(s.api.calls.filter((c) => c.kind === 'alerts').every((c) => !c.params.has('key')));
});

test('the 8-bit print cannot tell the key back: 1 key in 256 shares it', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  s.app.load();
  const target = s.app.keyPrint(TRAIN_KEY);
  let same = 0;
  for (let i = 0; i < 4096; i += 1) {
    if (s.app.keyPrint(`k${i.toString(16).padStart(15, '0')}`) === target) same += 1;
  }
  assert.ok(same > 4 && same < 40, `${same} of 4096`);
});

test('no key for a service: its watches say so, nothing is sent', async (t) => {
  const s = await setup({ config: { ...HOME, bus_key: '' } });
  t.after(() => s.app.stop());
  await s.begin();
  assert.equal(s.api.count('bus'), 0);
  assert.match(statusEn(s.fake), /Bus Tracker key: No API key for this service/);
  assert.deepEqual(published(s.fake, B(FEATURES.NEXT)), []);
});

test('another key has its own count; a quota day after tomorrow in /data is not believed', async () => {
  const probe = await setup();
  probe.app.load();
  const salt = probe.app.persisted.salt;
  const print = probe.app.keyPrint(TRAIN_KEY);
  await probe.app.stop();
  // Another key with another print (the 8-bit print may collide: pick one that differs).
  let other = 'abcdef0123456789';
  for (let i = 0; probe.app.keyPrint(other) === print; i += 1) other = `abcdef012345678${i}`;
  for (const [quota, key, sent] of [
    [{ day: TODAY, count: 500, key: print }, TRAIN_KEY, 0],
    [{ day: TODAY, count: 500, key: print }, other, 1],
    [{ day: '2027-01-15', count: 500, key: print }, TRAIN_KEY, 1],
  ]) {
    const store = createMemoryStore({ salt, quota: { train: quota } });
    const s = await setup({ store, config: { ...HOME, train_key: key, daily_budget: '500' } });
    await s.begin();
    await s.app.stop();
    assert.equal(
      s.api.count('train'),
      sent,
      `${key === TRAIN_KEY ? 'same' : 'other'} key, ${quota.day}`,
    );
  }
});

test('in the process, any key change lifts a refusal, even one with the same 8-bit print', async (t) => {
  const api = createApi((call, a) =>
    call.kind === 'train' && call.params.get('key') === TRAIN_KEY
      ? trainError(a.clock.now(), 101)
      : defaultWorld(call, a),
  );
  const s = await setup({ api });
  t.after(() => s.app.stop());
  await s.begin();
  const print = s.app.keyPrint(TRAIN_KEY);
  let twin = null;
  for (let i = 0; !twin; i += 1) {
    const candidate = `twin${String(i).padStart(12, '0')}`;
    if (s.app.keyPrint(candidate) === print) twin = candidate;
  }
  await s.app.start({ ...HOME, train_key: twin });
  await s.wait(61 * SECOND);
  assert.equal(s.api.count('train'), 2);
  assert.deepEqual(published(s.fake, T(FEATURES.DEPARTURES)), [2]);
});

test('a pause is never longer than 6 h, whatever the level kept in /data', async (t) => {
  const store = createMemoryStore({
    pause: { train: { until: null, kind: 'rate', status: 429, level429: 25, level5xx: 25 } },
  });
  const api = createApi((call, a) =>
    call.kind === 'train' ? json({}, { status: 429, date: a.clock.now() }) : defaultWorld(call, a),
  );
  const s = await setup({ store, api });
  t.after(() => s.app.stop());
  await s.begin();
  assert.ok(store.data.pause.train.until - s.clock.now() <= 6 * HOUR);
  await s.wait(6 * HOUR + 2 * MINUTE);
  assert.equal(s.api.count('train'), 2);
});

test('a bus prediction generated more than 10 min before the answer: a frozen feed', async (t) => {
  const api = createApi((call, a) => {
    if (call.kind === 'bus') {
      return busDoc([
        { ...defaultWorld(call, a)['bustime-response'].prd[0], tmstmp: '20261127 05:03:00' },
      ]);
    }
    return defaultWorld(call, a);
  });
  const s = await setup({ api });
  t.after(() => s.app.stop());
  await s.begin();
  assert.deepEqual(published(s.fake, B(FEATURES.NEXT)), []);
  assert.match(statusEn(s.fake), /Madison|456/);
  assert.match(statusEn(s.fake), /real-time data is not updated/);
});

test('an unreadable /data is read again every 10 s; once readable, merged on the safe side', async (t) => {
  const SALT = 'ab'.repeat(16);
  const print = createHash('sha256').update(`${SALT}\u0000${TRAIN_KEY}`).digest('hex').slice(0, 2);
  let readable = false;
  let data = null;
  let loads = 0;
  let saves = 0;
  const store = {
    load() {
      loads += 1;
      return readable
        ? { status: 'ok', data: structuredClone(data) }
        : { status: 'unreadable', data: {} };
    },
    async save(next) {
      saves += 1;
      data = structuredClone(next);
    },
  };
  const s = await setup({ store, config: { ...HOME, daily_budget: '500' } });
  t.after(() => s.app.stop());
  await s.app.start({ ...HOME, daily_budget: '500' });
  await s.wait(31 * SECOND);
  assert.equal(s.api.count('train'), 1);
  assert.equal(saves, 0, 'never written while unreadable');
  const before = loads;
  await s.wait(30 * SECOND);
  assert.ok(loads - before >= 2 && loads - before <= 4, `${loads - before} reads in 30 s`);
  readable = true;
  data = { salt: SALT, quota: { train: { day: TODAY, count: 450, key: print } } };
  await s.wait(10 * SECOND);
  assert.equal(data.salt, SALT);
  assert.equal(data.quota.train.key, print);
  assert.ok(data.quota.train.count >= 450);
  // 500 - 450: 50 requests left today (one per 192 s, the interval stretched), never more.
  await s.wait(4 * 3600 * SECOND);
  assert.ok(s.api.count('train') <= 2 + 50, `${s.api.count('train')} train requests`);
  assert.equal(data.quota.train.count, 500);
  assert.doesNotMatch(statusEn(s.fake), /unreadable/);
});

test('a refusal found in /data once readable again holds, unless the CTA accepted the key meanwhile', async () => {
  const SALT = 'cd'.repeat(16);
  const print = createHash('sha256').update(`${SALT}\u0000${TRAIN_KEY}`).digest('hex').slice(0, 2);
  for (const [answer, sentAfter] of [
    ['network', 0],
    ['refused', 0],
    ['ok', 'some'],
  ]) {
    let readable = false;
    const store = {
      load: () =>
        readable
          ? { status: 'ok', data: { salt: SALT, refused: { train: print } } }
          : { status: 'unreadable', data: {} },
      save: async () => {},
    };
    const api = createApi((call, a) => {
      if (call.kind === 'train' && answer === 'network') return 'network';
      if (call.kind === 'train' && answer === 'refused') return trainError(a.clock.now(), 101);
      return defaultWorld(call, a);
    });
    const s = await setup({ store, api });
    await s.app.start(HOME);
    await s.wait(31 * SECOND);
    assert.equal(s.api.count('train'), 1);
    readable = true;
    await s.wait(10 * SECOND);
    await s.wait(5 * 60 * SECOND);
    await s.app.stop();
    const after = s.api.count('train') - 1;
    if (sentAfter === 0) assert.equal(after, 0, 'still refused');
    else assert.ok(after >= 4, `${after} reads after the merge`);
  }
});

test('a paused key spends nothing of its budget; a pause in /data holds after a restart', async () => {
  const store = createMemoryStore();
  const api = createApi((call, a) =>
    call.kind === 'train' ? json({}, { status: 429, date: a.clock.now() }) : defaultWorld(call, a),
  );
  const s = await setup({ store, api });
  await s.begin();
  await s.wait(10 * MINUTE);
  await s.app.stop();
  assert.equal(store.data.quota.train.count, s.api.count('train'));
  // A restart within the pause: nothing sent before its end.
  const until = store.data.pause.train.until;
  const again = await setup({ store, start: s.clock.now() });
  await again.begin();
  await again.wait(until - again.clock.now() - 30 * SECOND);
  assert.equal(again.api.count('train'), 0);
  await again.wait(2 * MINUTE);
  assert.ok(again.api.count('train') >= 1);
  await again.app.stop();
});

test('a bus stop the CTA does not know: said, and asked again after 30 min only', async (t) => {
  const s = await setup({
    api: createApi((call, a) =>
      call.kind === 'bus'
        ? busDoc(null, [{ stpid: '456', msg: 'No data found for parameter' }])
        : defaultWorld(call, a),
    ),
  });
  t.after(() => s.app.stop());
  await s.begin();
  await s.wait(10 * MINUTE);
  assert.equal(s.api.count('bus'), 1);
  assert.match(statusEn(s.fake), /Madison|bus stop 456: departures: The CTA does not know this id/);
});

test('a round that fails still arms the next one', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.begin();
  const devices = s.gladys.devices;
  Object.defineProperty(s.gladys, 'devices', {
    configurable: true,
    get() {
      throw new Error('broken');
    },
  });
  await s.wait(3 * MINUTE);
  assert.ok(s.api.count('train') >= 4, `${s.api.count('train')} rounds`);
  Object.defineProperty(s.gladys, 'devices', { configurable: true, value: devices });
});
