// Chicago local times of the CTA placed on the UTC time line, daylight saving
// time included; the day of the quotas is the Chicago date.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chicagoDay, nextChicagoMidnight, readChicagoTime } from '../src/time.js';

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

test('the three forms of the CTA, in winter (CST) and in summer (CDT)', () => {
  assert.equal(iso(readChicagoTime('2026-11-27T05:14:54')), '2026-11-27T11:14:54.000Z');
  assert.equal(iso(readChicagoTime('20261127 05:14:54')), '2026-11-27T11:14:54.000Z');
  assert.equal(iso(readChicagoTime('20261127 05:14')), '2026-11-27T11:14:00.000Z');
  assert.equal(iso(readChicagoTime('2026-07-01T12:00:00')), '2026-07-01T17:00:00.000Z');
  assert.equal(iso(readChicagoTime(' 2026-07-01T12:00:00.250 ')), '2026-07-01T17:00:00.000Z');
});

test('the hours of the changes: the skipped one read in CST, the repeated one the first', () => {
  // 8 March 2026, 02:00 CST -> 03:00 CDT.
  assert.equal(iso(readChicagoTime('2026-03-08T01:59:00')), '2026-03-08T07:59:00.000Z');
  assert.equal(iso(readChicagoTime('2026-03-08T02:30:00')), '2026-03-08T08:30:00.000Z');
  assert.equal(iso(readChicagoTime('2026-03-08T03:00:00')), '2026-03-08T08:00:00.000Z');
  // 1 November 2026, 02:00 CDT -> 01:00 CST: 01:30 happens twice.
  assert.equal(iso(readChicagoTime('2026-11-01T01:30:00')), '2026-11-01T06:30:00.000Z');
  assert.equal(iso(readChicagoTime('2026-11-01T02:30:00')), '2026-11-01T08:30:00.000Z');
});

test('what is not a CTA time is refused, never guessed', () => {
  for (const value of [
    '2026-11-27T05:14:54Z',
    '2026-11-27T05:14:54-06:00',
    '2026-02-30T00:00:00',
    '2026-11-27T24:00:00',
    '2026-11-27',
    '',
    null,
    1764240894000,
    '27/11/2026 05:14',
  ]) {
    assert.equal(readChicagoTime(value), null, String(value));
  }
  assert.equal(iso(readChicagoTime('2026-01-05', { dateOnly: true })), '2026-01-05T06:00:00.000Z');
  assert.equal(iso(readChicagoTime('20260705', { dateOnly: true })), '2026-07-05T05:00:00.000Z');
});

test('the Chicago day and its next midnight, west and east of midnight UTC', () => {
  // 23:59 in Chicago is already the next day in UTC.
  assert.equal(chicagoDay(Date.parse('2026-11-28T05:59:00Z')), '2026-11-27');
  assert.equal(chicagoDay(Date.parse('2026-11-28T06:00:00Z')), '2026-11-28');
  assert.equal(
    iso(nextChicagoMidnight(Date.parse('2026-11-27T11:00:00Z'))),
    '2026-11-28T06:00:00.000Z',
  );
  // Across the fall change: midnight of 1 November is still CDT.
  assert.equal(
    iso(nextChicagoMidnight(Date.parse('2026-11-01T04:30:00Z'))),
    '2026-11-01T05:00:00.000Z',
  );
  assert.equal(
    iso(nextChicagoMidnight(Date.parse('2026-11-01T05:30:00Z'))),
    '2026-11-02T06:00:00.000Z',
  );
  // Across the spring change.
  assert.equal(
    iso(nextChicagoMidnight(Date.parse('2026-03-08T10:00:00Z'))),
    '2026-03-09T05:00:00.000Z',
  );
});
