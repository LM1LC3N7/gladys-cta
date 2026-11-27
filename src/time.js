// -----------------------------------------------------------------------------
// Chicago local time. The CTA APIs give their times in local Chicago time
// without an offset ("2026-11-27T05:14:54", "20261127 05:14:54",
// "20261127 05:14", a date alone for some alerts): they are placed on the
// UTC time line with the rules of America/Chicago (daylight saving time
// included). Pure functions, no clock read.
// -----------------------------------------------------------------------------

import { TIME_ZONE } from './constants.js';

const FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The local fields of a UTC time in Chicago: `{ year, month, day, hour, minute, second }`. */
export function chicagoParts(ms) {
  const p = {};
  for (const { type, value } of FORMAT.formatToParts(new Date(ms))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return p;
}

/**
 * A local Chicago time to UTC ms. Chicago is 5 h (CDT) or 6 h (CST) behind
 * UTC: the reading that shows the same local time wins; in the hour repeated
 * in the fall, the first of the two (CDT); in the hour skipped in spring,
 * the offset before the change (CST).
 */
export function chicagoToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (const candidate of [guess + 5 * 3600 * 1000, guess + 6 * 3600 * 1000]) {
    const p = chicagoParts(candidate);
    if (p.day === day && p.hour === hour && p.minute === minute) return candidate;
  }
  return guess + 6 * 3600 * 1000;
}

const PATTERNS = [
  // ISO without offset, as the JSON outputs send: 2026-11-27T05:14:54
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?$/,
  // The documented form: 20261127 05:14:54 or 20261127 05:14
  /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/,
];
const DATE_ONLY = [/^(\d{4})-(\d{2})-(\d{2})$/, /^(\d{4})(\d{2})(\d{2})$/];

function valid(y, mo, d, h, mi, s) {
  if (y < 2000 || y > 2200 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
}

/**
 * A local time of the CTA in UTC ms, or `null` when it cannot be read. A time
 * carrying an offset or a `Z` is refused: the CTA never sends one, a
 * different format means a change to look at, not a guess.
 */
export function readChicagoTime(value, { dateOnly = false } = {}) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  for (const pattern of PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
    const s = m[6] === undefined ? 0 : Number(m[6]);
    if (!valid(y, mo, d, h, mi, s)) return null;
    return chicagoToUtc(y, mo, d, h, mi, s);
  }
  if (dateOnly) {
    for (const pattern of DATE_ONLY) {
      const m = pattern.exec(text);
      if (!m) continue;
      const [y, mo, d] = m.slice(1, 4).map(Number);
      if (!valid(y, mo, d, 0, 0, 0)) return null;
      return chicagoToUtc(y, mo, d, 0, 0, 0);
    }
  }
  return null;
}

/** The local date in Chicago, `"2026-11-27"`: the day of the daily quotas. */
export function chicagoDay(ms) {
  const p = chicagoParts(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The next local midnight in Chicago after `ms`, in UTC ms. */
export function nextChicagoMidnight(ms) {
  const p = chicagoParts(ms);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return chicagoToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}
