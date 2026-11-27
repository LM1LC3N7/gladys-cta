// The three APIs read strictly: their error codes, their lists of one, the
// live alerts capture; the HTTP layer bounded in size and time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertsUrl,
  busUrl,
  getJson,
  readAlerts,
  readBus,
  readTrain,
  trainUrl,
} from '../src/cta.js';
import { MAX_BODY_BYTES, REQUEST_TIMEOUT, USER_AGENT } from '../src/constants.js';
import { settle, testClock } from './kit/clock.mjs';
import {
  ALERTS_LIVE,
  CAPTURED_AT,
  alert,
  alertsDoc,
  busDoc,
  eta,
  json,
  prd,
  trainDoc,
  trainError,
} from './helpers/setup.js';

const NOW = CAPTURED_AT;

test('the URLs: the key in the query string only; a station or a platform', () => {
  const t = new URL(trainUrl('KEY123456', '40380'));
  assert.equal(t.origin + t.pathname, 'https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx');
  assert.deepEqual(Object.fromEntries(t.searchParams), {
    key: 'KEY123456',
    mapid: '40380',
    outputType: 'JSON',
  });
  assert.equal(new URL(trainUrl('K1234567', '30074')).searchParams.get('stpid'), '30074');
  const b = new URL(busUrl('KEY123456', ['456', '1392']));
  assert.equal(b.pathname, '/bustime/api/v3/getpredictions');
  assert.equal(b.searchParams.get('stpid'), '456,1392');
  assert.equal(b.searchParams.get('format'), 'json');
  const a = new URL(alertsUrl({ routes: ['20', 'X9'] }));
  assert.equal(a.searchParams.get('routeid'), '20,X9');
  assert.equal(a.searchParams.get('activeonly'), 'true');
  assert.equal(a.searchParams.get('key'), null);
  assert.equal(new URL(alertsUrl({ station: '40380' })).searchParams.get('stationid'), '40380');
});

test('Train Tracker: the arrivals; a list of one; the error codes', () => {
  const read = readTrain(trainDoc(NOW, [eta(NOW, 4), eta(NOW, 9, { isDly: '1', isSch: '1' })]));
  assert.equal(read.ok, true);
  assert.equal(read.at, NOW - (NOW % 1000));
  assert.equal(read.etas.length, 2);
  assert.equal(read.etas[1].delayed, true);
  assert.equal(read.etas[1].scheduled, true);
  assert.equal(readTrain(trainDoc(NOW, eta(NOW, 4))).etas.length, 1);
  assert.deepEqual(readTrain(trainDoc(NOW, undefined)).etas, []);
  const kind = (code) => readTrain(trainError(NOW, code)).kind;
  assert.equal(kind(101), 'key_refused');
  assert.equal(kind(102), 'quota');
  for (const code of [103, 104, 108, 112]) assert.equal(kind(code), 'stop_missing');
  assert.equal(kind(900), 'server');
  assert.equal(kind(500), 'api_error');
  assert.equal(kind(100), 'api_error');
  assert.equal(readTrain({ ctatt: { errCd: 'x' } }).kind, 'format');
  assert.equal(readTrain('<html>').kind, 'format');
  assert.equal(readTrain(trainDoc(NOW, [], { tmst: 'soon' })).kind, 'no_date');
});

test('Train Tracker: one arrival that cannot be read refuses the whole answer', () => {
  for (const over of [
    { arrT: '2026-11-27T05:20:00Z' },
    { staId: '30074' },
    { rt: '' },
    { isApp: 'maybe' },
    { prdt: null },
  ]) {
    const read = readTrain(trainDoc(NOW, [eta(NOW, 4), eta(NOW, 6, over)]));
    assert.equal(read.kind, 'unreadable', JSON.stringify(over));
  }
});

test('Bus Tracker: predictions, per-stop errors, whole-request errors', () => {
  const read = readBus(
    busDoc(
      [prd(NOW, 3), prd(NOW, 8, { dyn: 1 }), prd(NOW, 9, { dly: true })],
      [
        { stpid: '1392', msg: 'No service scheduled' },
        { stpid: '99999', msg: 'No data found for parameter' },
        { stpid: '17', msg: 'Something new' },
      ],
    ),
  );
  assert.equal(read.ok, true);
  assert.equal(read.prds.length, 3);
  assert.equal(read.prds[1].skip, true);
  assert.equal(read.prds[2].delayed, true);
  assert.deepEqual(Object.fromEntries(read.stops), {
    1392: 'empty',
    99999: 'missing',
    17: 'error',
  });
  assert.equal(readBus(busDoc(prd(NOW, 3))).prds.length, 1);
  const whole = (msg) => readBus(busDoc(null, [{ msg }])).kind;
  assert.equal(whole('Invalid API access key supplied'), 'key_refused');
  assert.equal(whole('No API access permitted'), 'key_refused');
  assert.equal(whole('Transaction limit for current day has been exceeded.'), 'quota');
  assert.equal(whole('Internal server error - Unable to complete request at this time'), 'server');
  assert.equal(whole('Unsupported version requested'), 'api_error');
  assert.equal(readBus(busDoc(null, [{ msg: 'No service scheduled' }])).allEmpty, true);
  assert.equal(readBus(busDoc([prd(NOW, 3, { prdtm: '20261127 5:20' })])).kind, 'unreadable');
  assert.equal(readBus(busDoc([prd(NOW, 3, { dly: 'perhaps' })])).kind, 'unreadable');
  assert.equal(readBus({ error: 'x' }).kind, 'format');
});

test('Customer Alerts: the live capture, code 50 is empty, an unknown station is an error', () => {
  const read = readAlerts(ALERTS_LIVE);
  assert.equal(read.ok, true);
  assert.equal(read.alerts.length, 9);
  assert.equal(read.at, Date.parse('2026-11-27T11:14:54Z'));
  const closure = read.alerts.find((a) => a.id === '112148');
  assert.equal(closure.headline, 'State/Lake Elevated Station Temporary Closure');
  assert.equal(closure.start, Date.parse('2026-01-05T06:00:00Z'));
  assert.equal(closure.severity, 12);
  assert.equal(closure.major, false);
  assert.match(closure.url, /^https:\/\/www\.transitchicago\.com\/travel_information\//);
  assert.deepEqual(readAlerts(alertsDoc(NOW, [])).alerts, []);
  // Seen live for stationid=99999: another envelope, code 900.
  const unknown = {
    CTARoutes: { TimeStamp: '2026-11-27T05:16:15', ErrorCode: '900', ErrorMessage: 'Server Error' },
  };
  assert.equal(readAlerts(unknown).kind, 'server');
  const one = {
    CTAAlerts: { TimeStamp: '2026-11-27T05:16:15', ErrorCode: '0', Alert: alert(5, NOW) },
  };
  assert.equal(readAlerts(one).alerts.length, 1);
  assert.equal(
    readAlerts({ CTAAlerts: { TimeStamp: '2026-11-27T05:16:15', ErrorCode: '106' } }).kind,
    'api_error',
  );
  const bad = alertsDoc(NOW, [alert(1, NOW), alert(2, NOW, { Headline: '' })]);
  assert.equal(readAlerts(bad).kind, 'unreadable');
  const elsewhere = readAlerts(
    alertsDoc(NOW, [alert(3, NOW, { AlertURL: 'https://evil.example/x' })]),
  );
  assert.equal(elsewhere.alerts[0].url, '');
});

test('getJson: an honest User-Agent, no redirect followed, statuses sorted', async () => {
  let init;
  const ok = await getJson('https://x.test/a', {
    fetchImpl: async (_u, i) => {
      init = i;
      return json({ a: 1 }, { date: NOW });
    },
  });
  assert.deepEqual(ok, { ok: true, json: { a: 1 }, serverDate: NOW - (NOW % 1000) });
  assert.equal(init.headers['User-Agent'], USER_AGENT);
  assert.match(
    USER_AGENT,
    /^gladys-cta\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-cta\)$/,
  );
  assert.equal(init.redirect, 'error');
  const status = async (code, headers) =>
    getJson('u', { fetchImpl: async () => json({}, { status: code, date: NOW, headers }) });
  const rate = await status(429, { 'retry-after': '120' });
  assert.equal(rate.kind, 'rate');
  assert.equal(rate.retryAfter, 120000);
  assert.equal((await status(429, { 'retry-after': '99999999' })).retryAfter, 6 * 3600 * 1000);
  assert.equal((await status(503)).kind, 'server');
  assert.equal((await status(403)).kind, 'http');
  const html = await getJson('u', {
    fetchImpl: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(html.kind, 'format');
});

test('getJson: a body too large is cut, announced or streamed', async () => {
  const announced = await getJson('u', {
    fetchImpl: async () => json({}, { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
  });
  assert.equal(announced.kind, 'too_big');
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 1000) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const streamed = await getJson('u', {
    fetchImpl: async () =>
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(streamed.kind, 'too_big');
  assert.ok(pulled < 40, `${pulled} chunks read`);
});

test('getJson: a server that never answers times out at 15 s, never throws', async () => {
  const clock = testClock({ start: NOW });
  const job = getJson('u', {
    timers: clock.timers,
    fetchImpl: (_u, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  });
  await clock.advance(REQUEST_TIMEOUT);
  // Bounded: a request that would not end fails the test, never hangs it.
  const outcome = await Promise.race([job, settle(20).then(() => 'still pending')]);
  assert.deepEqual(outcome, { ok: false, kind: 'timeout', serverDate: null });
  const refused = await getJson('u', {
    fetchImpl: async () => {
      throw new TypeError('fetch failed https://lapi.transitchicago.com/?key=SECRET');
    },
  });
  assert.equal(JSON.stringify(refused).includes('SECRET'), false);
});
