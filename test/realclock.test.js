// -----------------------------------------------------------------------------
// The app on the REAL moving clock (performance.now, Date.now, setTimeout)
// sped up 20 times, against a real local HTTP server playing the CTA: the
// rounds really start at the interval (measured on the method that decides),
// two requests are 1 s apart, the timers stay bounded. Cleanup in `t.after`:
// a failing test never leaves a process running.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CtaApp } from '../src/app.js';
import { REQUEST_GAP } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { HOME, alertsDoc, busDoc, eta, prd, trainDoc } from './helpers/setup.js';

const SPEED = 20;
const REFRESH = 30;

test('real clock x20: one round per interval, requests 1 s apart, bounded timers', async (t) => {
  const clock = realClock({ speed: SPEED });
  const requests = [];
  const sent = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const now = Date.now();
    let body;
    if (req.url.startsWith('/train')) body = trainDoc(now, [eta(now, 5)]);
    else if (req.url.startsWith('/bus')) body = busDoc([prd(now, 7)]);
    else body = alertsDoc(now, []);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      date: new Date(now).toUTCString(),
    });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { ...HOME, refresh_seconds: REFRESH };
  const gladys = createFakeGladys({ selector: 'cta', config });
  await gladys.connect();
  const quiet = () => {};
  const app = new CtaApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    urls: { train: `${base}/train`, bus: `${base}/bus`, alerts: `${base}/alerts` },
    fetchImpl: (url, init) => {
      sent.push(clock.monotonic());
      return fetch(url, {
        ...init,
        signal: AbortSignal.any([init.signal, AbortSignal.timeout(5000)]),
      });
    },
  });
  const spy = spyOn(app, 'round', clock);
  t.after(async () => {
    await app.stop();
    clock.close();
    spy.restore();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await app.start(config);
  const gaps = await measurePeriod(spy, { count: 3, period: REFRESH * 1000 });
  assert.equal(gaps.length, 2);
  // Round 1: train, bus, two alerts; rounds 2 and 3: train and bus.
  assert.ok(requests.length >= 6, `${requests.length} requests`);
  for (let i = 1; i < sent.length; i += 1) {
    const gap = sent[i] - sent[i - 1];
    assert.ok(gap >= 0.9 * REQUEST_GAP, `gap ${Math.round(gap)} ms`);
  }
  assert.match(requests[0].headers['user-agent'], /^gladys-cta\//);
  assert.ok(requests.some((r) => r.url.startsWith('/train?key=') && r.url.includes('mapid=40380')));
  assert.ok(clock.timersSet < 80, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
