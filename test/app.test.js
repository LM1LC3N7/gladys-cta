// The app on a virtual clock against a scripted CTA: what each watch
// publishes, the alerts and their scene trigger, and what it never publishes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/constants.js';
import {
  ALERTS_LIVE,
  BEGIN,
  CAPTURED_AT,
  D,
  F,
  HOME,
  MINUTE,
  SECOND,
  alert,
  alertEvents,
  alertsDoc,
  busDoc,
  createApi,
  defaultWorld,
  eta,
  json,
  prd,
  published,
  setup,
  statusEn,
  trainDoc,
  trainError,
} from './helpers/setup.js';

const T = (key) => F('train', 1, '40380', key);
const B = (key) => F('bus', 1, '456', key);

test('first round: trains, buses, then the alerts; texts and counters published', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.begin();
  assert.deepEqual(
    s.api.calls.map((c) => c.kind),
    ['train', 'bus', 'alerts', 'alerts'],
  );
  // One request at a time, 1 s apart at least.
  assert.equal(s.api.peak, 1);
  for (let i = 1; i < s.api.calls.length; i += 1) {
    assert.ok(s.api.calls[i].at - s.api.calls[i - 1].at >= SECOND - 1);
  }
  assert.deepEqual(published(s.fake, T(FEATURES.NEXT)), [
    'Green Line → Harlem/Lake in 4 min (05:18)',
  ]);
  assert.deepEqual(published(s.fake, T(FEATURES.SECOND)), [
    'Brown Line → Kimball in 11 min (05:25)',
  ]);
  assert.deepEqual(published(s.fake, T(FEATURES.DEPARTURES)), [2]);
  assert.match(
    published(s.fake, T(FEATURES.SUMMARY))[0],
    /^05:14 · Green Line → Harlem\/Lake 4 min · Brown Line → Kimball 11 min$/,
  );
  assert.deepEqual(published(s.fake, B(FEATURES.NEXT)), ['20 → Austin in 6 min (05:20)']);
  assert.deepEqual(published(s.fake, B(FEATURES.SECOND)), ['No following departure (read 05:14)']);
  // Alerts of Clark/Lake from the live capture; the bus alerts by route 20.
  // Of the 9 alerts the CTA gives for Clark/Lake, 7 are elevators of other
  // stations of its lines: only the station's own and the lines' alerts stay.
  assert.deepEqual(published(s.fake, T(FEATURES.ALERTS)), [2]);
  assert.match(published(s.fake, T(FEATURES.ALERT_TEXT))[0], /\(1 more alert\)$/);
  const busAlerts = s.api.calls.filter((c) => c.kind === 'alerts')[1];
  assert.equal(busAlerts.params.get('routeid'), '20');
  assert.deepEqual(published(s.fake, B(FEATURES.ALERTS)), [0]);
  assert.deepEqual(published(s.fake, B(FEATURES.ALERT_TEXT)), ['No alert']);
  assert.equal(s.fake.connectionStatus.connected, true);
  assert.match(statusEn(s.fake), /Train Tracker key: 1 of 10000 requests today/);
  // The device names follow the CTA names once read.
  const names = s.fake.discoveredDevices.map((d) => d.name);
  assert.deepEqual(names, ["Clark/Lake ('L' trains)", 'Madison & Jefferson (buses)']);
});

test('the next rounds come at the interval; the alerts every 5 minutes', async (t) => {
  const s = await setup();
  t.after(() => s.app.stop());
  await s.begin();
  await s.wait(60 * SECOND - BEGIN);
  assert.equal(s.api.count('train'), 2);
  assert.equal(s.api.count('alerts'), 2);
  await s.wait(4 * MINUTE + 5 * SECOND);
  assert.equal(s.api.count('train'), 6);
  assert.equal(s.api.count('bus'), 6);
  assert.equal(s.api.count('alerts'), 4);
  const trains = s.api.calls.filter((c) => c.kind === 'train');
  for (let i = 1; i < trains.length; i += 1) {
    assert.ok(Math.abs(trains[i].at - trains[i - 1].at - 60 * SECOND) < 2 * SECOND);
  }
});

test('a departure gone is replaced by its text, never left as a number', async (t) => {
  let empty = false;
  const s = await setup({
    api: createApi((call, api) => {
      const now = api.clock.now();
      if (call.kind === 'train') return trainDoc(now, empty ? [] : [eta(now, 4)]);
      return defaultWorld(call, api);
    }),
  });
  t.after(() => s.app.stop());
  await s.begin();
  empty = true;
  await s.wait(60 * SECOND);
  assert.deepEqual(
    published(s.fake, T(FEATURES.NEXT)).at(-1),
    'No predicted departure (read 05:15)',
  );
  assert.deepEqual(published(s.fake, T(FEATURES.DEPARTURES)), [1, 0]);
  assert.match(published(s.fake, T(FEATURES.SUMMARY)).at(-1), /No predicted departure$/);
});

test('delayed, scheduled, approaching, route filter and canceled buses', async (t) => {
  const s = await setup({
    config: { ...HOME, train1_routes: 'Brown', bus1_routes: '20' },
    api: createApi((call, api) => {
      const now = api.clock.now();
      if (call.kind === 'train') {
        return trainDoc(now, [
          eta(now, 0.5, { isApp: '1', rt: 'Brn', destNm: 'Kimball' }),
          eta(now, 3),
          eta(now, 7, { rt: 'Brn', destNm: 'Kimball', isDly: '1', isSch: '1' }),
        ]);
      }
      if (call.kind === 'bus') {
        return busDoc([
          prd(now, 2, { dyn: 1 }),
          prd(now, 3, { rt: '8', rtdd: '8', des: 'Waveland' }),
          prd(now, 5, { dly: true }),
          prd(now, 6, { dyn: 4 }),
        ]);
      }
      return defaultWorld(call, api);
    }),
  });
  t.after(() => s.app.stop());
  await s.begin();
  assert.deepEqual(published(s.fake, T(FEATURES.NEXT)), ['Brown Line → Kimball due (05:15)']);
  assert.deepEqual(published(s.fake, T(FEATURES.SECOND)), [
    'Brown Line → Kimball in 7 min (05:21, delayed, scheduled time)',
  ]);
  assert.deepEqual(published(s.fake, T(FEATURES.DEPARTURES)), [2]);
  assert.deepEqual(published(s.fake, B(FEATURES.NEXT)), ['20 → Austin in 5 min (05:19, delayed)']);
  assert.deepEqual(published(s.fake, B(FEATURES.DEPARTURES)), [1]);
});

test('French texts in Chicago time', async (t) => {
  const s = await setup({ config: { ...HOME, language: 'fr' } });
  t.after(() => s.app.stop());
  await s.begin();
  assert.deepEqual(published(s.fake, T(FEATURES.NEXT)), [
    'Green Line → Harlem/Lake dans 4 min (05:18)',
  ]);
  assert.deepEqual(published(s.fake, B(FEATURES.SECOND)), ['Aucun départ suivant (lu à 05:14)']);
  assert.match(s.fake.connectionStatus.message.fr, /heure de Chicago/);
});

test('nothing is published for a device the user has not created', async (t) => {
  const s = await setup({ created: false });
  t.after(() => s.app.stop());
  await s.begin();
  assert.equal(s.fake.states.length, 0);
  assert.equal(s.fake.connectionStatus.connected, true);
});

test('a frozen feed, a wrong clock, an unreadable answer: nothing published, never 0', async (t) => {
  for (const [name, world, wall, expect] of [
    [
      'old predictions',
      (call, api) => {
        const now = api.clock.now();
        if (call.kind === 'train')
          return trainDoc(now, [eta(now, 4, { prdt: trainDoc(now - 11 * MINUTE, []).ctatt.tmst })]);
        return defaultWorld(call, api);
      },
      0,
      /real-time data is not updated/,
    ],
    [
      'old time stamp',
      (call, api) => {
        const now = api.clock.now();
        if (call.kind === 'train') return trainDoc(now - 4 * MINUTE, []);
        return defaultWorld(call, api);
      },
      0,
      /real-time data is not updated/,
    ],
    [
      'local clock 10 min late',
      defaultWorld,
      -10 * MINUTE,
      /differs from the clock of this machine.*\(\+10 min\)/,
    ],
    [
      'unreadable arrival',
      (call, api) => {
        const now = api.clock.now();
        if (call.kind === 'train') return trainDoc(now, [eta(now, 4), { rt: 'G' }]);
        return defaultWorld(call, api);
      },
      0,
      /cannot be read/,
    ],
    [
      'no Date header',
      (call, api) =>
        call.kind === 'train'
          ? json(trainDoc(api.clock.now(), []), { date: null })
          : defaultWorld(call, api),
      0,
      /no usable time/,
    ],
  ]) {
    // The server keeps the true time (`clock.now`); the local clock is offset.
    const api = createApi(world);
    const s = await setup({ api, wall: { offset: wall } });
    await s.begin();
    await s.app.stop();
    assert.deepEqual(published(s.fake, T(FEATURES.NEXT)), [], name);
    assert.deepEqual(published(s.fake, T(FEATURES.DEPARTURES)), [], name);
    assert.match(statusEn(s.fake), expect, name);
    t.diagnostic(`${name}: ok`);
  }
});

test('an unknown station is asked again after 30 min only; the bus stop goes on', async (t) => {
  const s = await setup({
    api: createApi((call, api) =>
      call.kind === 'train'
        ? trainError(api.clock.now(), 103, 'Invalid mapid: 40380')
        : defaultWorld(call, api),
    ),
  });
  t.after(() => s.app.stop());
  await s.begin();
  assert.match(statusEn(s.fake), /does not know this id/);
  await s.wait(20 * MINUTE);
  assert.equal(s.api.count('train'), 1);
  assert.equal(s.api.count('bus'), 21);
  await s.wait(11 * MINUTE);
  assert.equal(s.api.count('train'), 2);
  assert.deepEqual(published(s.fake, T(FEATURES.DEPARTURES)), []);
});

test('a bus stop never confirmed by a prediction: "no service" is not published', async (t) => {
  let service = false;
  const s = await setup({
    api: createApi((call, api) => {
      const now = api.clock.now();
      if (call.kind === 'bus') {
        return service
          ? busDoc([prd(now, 6)])
          : busDoc(null, [{ stpid: '456', msg: 'No service scheduled' }]);
      }
      return defaultWorld(call, api);
    }),
  });
  t.after(() => s.app.stop());
  await s.begin();
  assert.deepEqual(published(s.fake, B(FEATURES.NEXT)), []);
  assert.match(statusEn(s.fake), /no bus has confirmed this stop id yet/);
  // No route seen yet: the bus alerts wait.
  assert.equal(s.api.calls.filter((c) => c.kind === 'alerts').length, 1);
  service = true;
  await s.wait(60 * SECOND);
  service = false;
  await s.wait(60 * SECOND);
  // Once confirmed, an empty stop is told.
  assert.deepEqual(published(s.fake, B(FEATURES.DEPARTURES)), [1, 0]);
});

test('the alerts scene trigger: the first read learns, a new alert fires once', async (t) => {
  const extra = [];
  const s = await setup({
    api: createApi((call, api) => {
      const now = api.clock.now();
      if (call.kind === 'alerts' && call.params.get('stationid'))
        return alertsDoc(now, [alert(100, now), ...extra]);
      return defaultWorld(call, api);
    }),
  });
  t.after(() => s.app.stop());
  await s.begin();
  assert.equal(alertEvents(s.fake).length, 0);
  const now = s.clock.wall();
  extra.push(
    alert(101, now, { MajorAlert: '1', SeverityScore: '80', Headline: 'Major delays' }),
    alert(102, now, { EventStart: '2026-11-20T05:00:00' }),
  );
  await s.wait(5 * MINUTE);
  const events = alertEvents(s.fake);
  assert.equal(events.length, 1, 'an alert started a week ago is learnt, not announced');
  assert.deepEqual(events[0].data, {
    device: D('train', 1, '40380'),
    alert_id: '101',
    major: 'yes',
    severity: 80,
    headline: 'Major delays',
    description: 'Trains are running with delays.',
    impact: 'Minor Delays',
    url: 'https://www.transitchicago.com/travel_information/alert_detail.aspx?AlertId=101',
  });
  await s.wait(5 * MINUTE);
  assert.equal(alertEvents(s.fake).length, 1);
  assert.match(
    published(s.fake, T(FEATURES.ALERT_TEXT)).at(-1),
    /^Major delays \(2 more alerts\)$/,
  );
});

test('an alerts failure is spaced out and never holds the departures', async (t) => {
  const s = await setup({
    api: createApi((call, api) => (call.kind === 'alerts' ? 'network' : defaultWorld(call, api))),
  });
  t.after(() => s.app.stop());
  await s.begin();
  await s.wait(9 * MINUTE);
  // Failed at 0, retried at 5 min, then 10 min later.
  assert.equal(s.api.count('alerts'), 4);
  assert.equal(s.api.count('train'), 10);
  assert.deepEqual(published(s.fake, T(FEATURES.ALERTS)), []);
  assert.equal(published(s.fake, T(FEATURES.DEPARTURES)).length, 10);
  assert.ok(ALERTS_LIVE);
  assert.equal(CAPTURED_AT % 1000, 0);
});

test('the alerts of a station: its own and its lines, never the elevators of other stations', async () => {
  const { concerning } = await import('../src/app.js');
  const { readAlerts } = await import('../src/cta.js');
  const kept = concerning(readAlerts(ALERTS_LIVE).alerts, { station: '40380' }).map((a) => a.id);
  assert.deepEqual(kept.sort(), ['112148', '118659']);
  const now = CAPTURED_AT;
  const bus = (services) =>
    readAlerts(alertsDoc(now, [alert(1, now, { ImpactedService: { Service: services } })])).alerts;
  assert.equal(
    concerning(bus([{ ServiceType: 'B', ServiceId: '20' }]), { routes: ['20'] }).length,
    1,
  );
  assert.equal(
    concerning(
      bus([
        { ServiceType: 'T', ServiceId: '41260' },
        { ServiceType: 'R', ServiceId: 'G' },
      ]),
      { routes: ['20'] },
    ).length,
    0,
  );
  assert.equal(
    concerning(
      bus([
        { ServiceType: 'T', ServiceId: '41260' },
        { ServiceType: 'B', ServiceId: '20' },
      ]),
      { routes: ['20'] },
    ).length,
    1,
  );
});

test('every dynamic action type that is not a departure is left out (dyn 1, 4, 12, 16, 17, 18)', async (t) => {
  for (const dyn of [1, 4, 12, 16, 17, 18]) {
    const s = await setup({
      api: createApi((call, api) => {
        const now = api.clock.now();
        if (call.kind === 'bus') return busDoc([prd(now, 3, { dyn }), prd(now, 9, { dyn: 0 })]);
        return defaultWorld(call, api);
      }),
    });
    await s.begin();
    await s.app.stop();
    assert.deepEqual(
      published(s.fake, B(FEATURES.NEXT)),
      ['20 → Austin in 9 min (05:23)'],
      `dyn ${dyn}`,
    );
    assert.deepEqual(published(s.fake, B(FEATURES.DEPARTURES)), [1], `dyn ${dyn}`);
  }
  t.diagnostic('ok');
});

test('a station read its alerts without waiting for Train Tracker (key refused)', async (t) => {
  const s = await setup({
    api: createApi((call, api) =>
      call.kind === 'train' ? trainError(api.clock.now(), 101) : defaultWorld(call, api),
    ),
  });
  t.after(() => s.app.stop());
  await s.begin();
  assert.deepEqual(published(s.fake, T(FEATURES.ALERTS)), [2]);
});

test('the scene trigger: flapping, a storm of 40, a start in the future or unknown', async (t) => {
  let list = [];
  const s = await setup({
    api: createApi((call, api) => {
      const now = api.clock.now();
      if (call.kind === 'alerts' && call.params.get('stationid')) return alertsDoc(now, list);
      return defaultWorld(call, api);
    }),
  });
  t.after(() => s.app.stop());
  const now = CAPTURED_AT;
  list = [alert(1, now)];
  await s.begin();
  // Gone for a read, then back: not new.
  list = [];
  await s.wait(5 * MINUTE);
  list = [alert(1, now)];
  await s.wait(5 * MINUTE);
  assert.equal(alertEvents(s.fake).length, 0);
  // A start in the future, an unknown start: learnt, not announced.
  list = [
    alert(1, now),
    alert(2, now, { EventStart: '2026-11-27T09:00:00' }),
    alert(3, now, { EventStart: null }),
  ];
  await s.wait(5 * MINUTE);
  assert.equal(alertEvents(s.fake).length, 0);
  // 40 new alerts at once: 10 events, none at the next read.
  list = Array.from({ length: 40 }, (_, i) => alert(100 + i, now));
  await s.wait(5 * MINUTE);
  assert.equal(alertEvents(s.fake).length, 10);
  await s.wait(5 * MINUTE);
  assert.equal(alertEvents(s.fake).length, 10);
});

test('an alerts answer whose own time stamp is far from its Date: nothing published', async (t) => {
  const s = await setup({
    api: createApi((call, api) =>
      call.kind === 'alerts'
        ? alertsDoc(api.clock.now() - 4 * MINUTE, [])
        : defaultWorld(call, api),
    ),
  });
  t.after(() => s.app.stop());
  await s.begin();
  assert.deepEqual(published(s.fake, T(FEATURES.ALERTS)), []);
  assert.match(statusEn(s.fake), /alerts: The CTA real-time data is not updated/);
});
