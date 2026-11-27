// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted CTA and a virtual clock
// (gladys-testkit `testClock`: each clock read moves 1 µs, timers fire only
// through `advance`). The CTA answers through a `world(call, api)` function:
// a JSON body (200, dated by the virtual clock), a Response, 'timeout'
// (never answers), 'network' (refused), or a promise of one of them.
//
// Train Tracker and Bus Tracker answers are built after the examples of the
// official documentation (no real key in this project); the alerts come
// from a live capture of 2026-11-27 (no key needed).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CtaApp } from '../../src/app.js';
import { normalizeConfig } from '../../src/config.js';
import { buildDevices } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { chicagoParts } from '../../src/time.js';
import { settle, testClock } from '../kit/clock.mjs';

export const SELECTOR = 'cta';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Test keys only (never real ones): letters and digits as the CTA's. */
export const TRAIN_KEY = 'e3875818a4743049aaaa1111bbbb2222';
export const BUS_KEY = '89dj2he89d8j3j3ksjhdue93j';

/** Customer Alerts for Clark/Lake (40380), captured live on 2026-11-27 11:14:55 UTC. */
export const ALERTS_LIVE = JSON.parse(
  readFileSync(new URL('../fixtures/alerts-clark-lake-live.json', import.meta.url), 'utf8'),
);
/** The time of the capture: 05:14:55 in Chicago (CST). */
export const CAPTURED_AT = Date.parse('2026-11-27T11:14:55Z');

export const HOME = {
  train_key: TRAIN_KEY,
  bus_key: BUS_KEY,
  train1_station: '40380',
  bus1_stop: '456',
};

/** The time `begin` lets the first round run (requests 1 s apart). */
export const BEGIN = 20 * SECOND;

const pad = (n, size = 2) => String(n).padStart(size, '0');
/** A Chicago local time as the JSON outputs send it: `2026-11-27T05:14:55`. */
export const local = (ms) => {
  const p = chicagoParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
};
/** The documented Bus Tracker form (tmres=s): `20261127 05:14:55`. */
export const compact = (ms) => {
  const p = chicagoParts(ms);
  return `${p.year}${pad(p.month)}${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
};

/** A feature id and a device id. */
export const F = (kind, slot, id, key) => `ext:${SELECTOR}:${kind}:${slot}-${id}:${key}`;
export const D = (kind, slot, id) => `ext:${SELECTOR}:${kind}:${slot}-${id}`;

/** One Train Tracker arrival (the JSON example of the docs), `minutes` ahead of `now`. */
export function eta(now, minutes, over = {}) {
  return {
    staId: '40380',
    stpId: '30074',
    staNm: 'Clark/Lake',
    stpDe: 'Service toward Harlem/Lake',
    rn: String(over.rn ?? 600 + Math.round(minutes)),
    rt: 'G',
    destSt: '30004',
    destNm: 'Harlem/Lake',
    trDr: '5',
    prdt: local(now - 30 * SECOND),
    arrT: local(now + minutes * MINUTE),
    isApp: '0',
    isSch: '0',
    isDly: '0',
    isFlt: '0',
    flags: null,
    lat: '41.88574',
    lon: '-87.62758',
    heading: '269',
    ...over,
  };
}
export const trainDoc = (now, etas, over = {}) => ({
  ctatt: { tmst: local(now), TimeStamp: local(now), errCd: '0', errNm: null, eta: etas, ...over },
});
export const trainError = (now, code, name = 'Error') => ({
  ctatt: { tmst: local(now), TimeStamp: local(now), errCd: String(code), errNm: name },
});

/** One Bus Tracker prediction (the JSON example of the v3 guide). */
export function prd(now, minutes, over = {}) {
  return {
    tmstmp: compact(now - 20 * SECOND),
    typ: 'A',
    stpnm: 'Madison & Jefferson',
    stpid: '456',
    vid: String(over.vid ?? 8100 + Math.round(minutes)),
    dstp: 686,
    rt: '20',
    rtdd: '20',
    rtdir: 'Westbound',
    des: 'Austin',
    prdtm: compact(now + minutes * MINUTE),
    tablockid: '20 -803',
    tatripid: String(1040700 + Math.round(minutes)),
    origtatripno: '262522629',
    dly: false,
    dyn: 0,
    prdctdn: minutes < 1 ? 'DUE' : String(Math.floor(minutes)),
    zone: '',
    psgld: '',
    stst: 57120,
    stsd: '2026-11-27',
    flagstop: 0,
    ...over,
  };
}
export const busDoc = (prds, errors) => ({
  'bustime-response': {
    ...(prds ? { prd: prds } : {}),
    ...(errors ? { error: errors } : {}),
  },
});

/** A Customer Alerts answer dated `now` (the live shape). */
export function alertsDoc(now, alerts) {
  if (alerts.length === 0) {
    return {
      CTAAlerts: {
        TimeStamp: local(now),
        ErrorCode: '50',
        ErrorMessage: 'There are no active alerts based on your filter criteria',
      },
    };
  }
  return {
    CTAAlerts: { TimeStamp: local(now), ErrorCode: '0', ErrorMessage: null, Alert: alerts },
  };
}
export function alert(id, now, over = {}) {
  return {
    AlertId: String(id),
    Headline: `Synthetic alert ${id}`,
    ShortDescription: 'Trains are running with delays.',
    FullDescription: { '#cdata-section': '<p>Details.</p>' },
    SeverityScore: '25',
    SeverityColor: 'f4a300',
    SeverityCSS: 'minor',
    Impact: 'Minor Delays',
    EventStart: local(now - 10 * MINUTE),
    EventEnd: null,
    TBD: '1',
    MajorAlert: '0',
    AlertURL: {
      '#cdata-section': `http://www.transitchicago.com/travel_information/alert_detail.aspx?AlertId=${id}`,
    },
    ImpactedService: { Service: [{ ServiceType: 'R', ServiceId: 'G', ServiceName: 'Green Line' }] },
    ttim: '0',
    GUID: '00000000-0000-0000-0000-000000000000',
    ...over,
  };
}

export function json(body, { status = 200, date, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(date === null || date === undefined ? {} : { date: new Date(date).toUTCString() }),
      ...headers,
    },
  });
}

const abortable = (signal, kind) =>
  new Promise((_, reject) => {
    if (kind === 'network') reject(new TypeError('fetch failed'));
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

/** The API of a request: `train`, `bus`, `alerts`. */
export function kindOf(url) {
  const u = new URL(url);
  if (u.pathname.endsWith('ttarrivals.aspx')) return 'train';
  if (u.pathname.endsWith('getpredictions')) return 'bus';
  if (u.pathname.endsWith('alerts.aspx')) return 'alerts';
  return 'other';
}

/** The default CTA: a train in 4 and 11 min, a bus in 6 min, no alert for buses. */
export function defaultWorld(call, api) {
  const now = api.clock.now();
  switch (call.kind) {
    case 'train':
      return trainDoc(now, [eta(now, 4), eta(now, 11, { rt: 'Brn', destNm: 'Kimball' })]);
    case 'bus':
      return busDoc([prd(now, 6)]);
    case 'alerts':
      return call.params.get('stationid') === '40380' ? ALERTS_LIVE : alertsDoc(now, []);
    default:
      return 'network';
  }
}

/** A scripted CTA: every request is recorded with the virtual time. */
export function createApi(world = defaultWorld) {
  const api = { world, calls: [], open: 0, peak: 0, clock: null };
  api.fetch = async (url, init) => {
    const u = new URL(String(url));
    const call = {
      url: String(url),
      kind: kindOf(String(url)),
      params: u.searchParams,
      init,
      at: api.clock.elapsed,
      wall: api.clock.now(),
    };
    api.calls.push(call);
    api.open += 1;
    api.peak = Math.max(api.peak, api.open);
    try {
      const answer = await api.world(call, api);
      if (answer === 'timeout' || answer === 'network') {
        return await abortable(init?.signal, answer);
      }
      if (answer instanceof Response) return answer;
      return json(answer, { date: api.clock.now() });
    } finally {
      api.open -= 1;
    }
  };
  api.count = (kind) => api.calls.filter((c) => c.kind === kind).length;
  return api;
}

/** The devices of a configuration as created by the user in Gladys. */
export function createdDevices(config) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevices(gladys, normalizeConfig(config));
}

export async function setup({
  config = HOME,
  devices,
  store = createMemoryStore(),
  api = createApi(),
  created = true,
  start = CAPTURED_AT,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: devices ?? (created ? createdDevices(config) : []),
  });
  await gladys.connect();
  const clock = testClock({ start });
  clock.wall = () => clock.now() + wall.offset;
  api.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new CtaApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.wall(),
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: api.fetch,
  });
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle(10);
  };
  /** Starts and lets the first round end. */
  const begin = async (cfg = config) => {
    await app.start(cfg);
    await wait(0);
    await wait(BEGIN);
  };
  return { app, gladys, fake: gladys.fake, clock, store, api, wait, begin, lines, wall };
}

/** The values published for a feature, in order. */
export const published = (fake, id) =>
  fake.states
    .filter((s) => s.device_feature_external_id === id)
    .map((s) => (s.text !== undefined ? s.text : s.state));

/** The "new alert" scene events. */
export const alertEvents = (fake) => fake.sceneEvents.filter((e) => e.key === 'new_alert');

/** The status message in English. */
export const statusEn = (fake) => fake.connectionStatus?.message?.en ?? '';
