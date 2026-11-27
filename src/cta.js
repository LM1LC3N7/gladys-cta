// -----------------------------------------------------------------------------
// The three APIs of the CTA Developer Center: one GET with an honest
// User-Agent, a bounded time and a bounded body (cut before it is read in
// full); then each answer read strictly into small objects. Nothing here
// retries, waits or keeps state: the app paces the requests and decides.
//
// As documented on transitchicago.com/developers (Train Tracker API, Bus
// Tracker API v3 guide of 2025-04-21, Customer Alerts API guide of
// 2016-09-29) and, for the keyless parts, checked on the live services on
// 2026-11-27:
//   - the errors come in a 200 answer: Train Tracker `errCd` (101 invalid
//     key, 102 daily limit, 103/104/108/112 unknown station or stop, 900
//     server error), Bus Tracker an `error` list of messages ("Invalid API
//     access key supplied", "Transaction limit for current day has been
//     exceeded.", "No service scheduled"...), Customer Alerts `ErrorCode`
//     (50: no alert matches, an empty list);
//   - the times are local Chicago times without offset;
//   - a list of one item may come as an object (XML converted to JSON): both read.
//
// The key travels in the query string, as the CTA requires: the URL of a
// keyed request is never logged nor shown; an error says its kind only.
// -----------------------------------------------------------------------------

import {
  ALERTS_URL,
  BUS_SKIP_DYN,
  BUS_URL,
  MAX_BODY_BYTES,
  MAX_ITEMS,
  PAUSE_MAX,
  REQUEST_TIMEOUT,
  TRAIN_URL,
  USER_AGENT,
} from './constants.js';
import { readChicagoTime } from './time.js';

const RETRY_AFTER_MAX_SECONDS = PAUSE_MAX / 1000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const TEXT_MAX = 2000;

/** Train Tracker arrivals of one station (4xxxx) or platform stop (3xxxx). */
export function trainUrl(key, id, base = TRAIN_URL) {
  const param = id.startsWith('4') ? 'mapid' : 'stpid';
  return `${base}?${new URLSearchParams({ key, [param]: id, outputType: 'JSON' })}`;
}

/** Bus Tracker predictions of up to 10 stops, times to the second. */
export function busUrl(key, stops, base = BUS_URL) {
  return `${base}?${new URLSearchParams({ key, stpid: stops.join(','), tmres: 's', format: 'json' })}`;
}

/** The alerts in effect now for a station, or for bus routes. */
export function alertsUrl({ station = null, routes = [] }, base = ALERTS_URL) {
  const params = { outputType: 'JSON', activeonly: 'true' };
  if (station) params.stationid = station;
  else params.routeid = routes.join(',');
  return `${base}?${new URLSearchParams(params)}`;
}

/**
 * One GET. Resolves `{ ok: true, json, serverDate }` or `{ ok: false, kind,
 * status?, retryAfter?, serverDate }`, `kind` among `network`, `timeout`,
 * `rate` (429), `server` (5xx), `http` (other status), `format`, `too_big`.
 * Never throws, never says the URL.
 */
export async function getJson(target, { fetchImpl = fetch, timers = globalThis } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetchImpl(target, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    timers.clearTimeout(timer);
    return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate: null };
  }
  const serverDate = readHttpDate(response.headers.get('date'));
  const base = { serverDate };
  try {
    if (response.status === 429) {
      const retryAfter = readRetryAfter(response.headers.get('retry-after'), serverDate);
      return { ok: false, kind: 'rate', status: 429, retryAfter, ...base };
    }
    if (response.status >= 500) {
      const retryAfter = readRetryAfter(response.headers.get('retry-after'), serverDate);
      return { ok: false, kind: 'server', status: response.status, retryAfter, ...base };
    }
    if (response.status !== 200) {
      return { ok: false, kind: 'http', status: response.status, ...base };
    }
    const type = response.headers.get('content-type') ?? '';
    if (!/\bjson\b/i.test(type)) return { ok: false, kind: 'format', status: 200, ...base };
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return { ok: false, kind: 'too_big', status: 200, ...base };
    }
    const text = await readBounded(response);
    if (text === null) return { ok: false, kind: 'too_big', status: 200, ...base };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, kind: 'format', status: 200, ...base };
    }
    return { ok: true, json, ...base };
  } catch {
    return { ok: false, kind: timedOut ? 'timeout' : 'network', ...base };
  } finally {
    timers.clearTimeout(timer);
    // A body left unread is released, never kept open.
    response.body?.cancel?.().catch?.(() => {});
  }
}

/** The body as text, or `null` past `max` bytes (the rest never read). */
async function readBounded(response, max = MAX_BODY_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/** An HTTP date (`Fri, 27 Nov 2026 11:14:55 GMT`) in ms, or `null`. */
export function readHttpDate(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `Retry-After` in ms (seconds or an HTTP date read against the server's). */
export function readRetryAfter(value, serverDate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text), RETRY_AFTER_MAX_SECONDS) * 1000;
  const at = readHttpDate(text);
  if (at !== null && serverDate !== null) return Math.max(0, at - serverDate);
  return null;
}

/** A text from the API, bounded, without control bytes; `''` when absent. */
export function readString(value, max = TEXT_MAX) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * A list as the CTA sends it: an array, one object (a list of one), absent
 * or null (empty). `null` when it is something else or longer than MAX_ITEMS.
 */
export function readList(value) {
  if (value === undefined || value === null) return [];
  if (isObject(value)) return [value];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  return value;
}

/** A code of the CTA ("0", 0, "101"): an integer, or null. */
function readCode(value) {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^\d{1,4}$/.test(text.trim()) ? Number(text) : null;
}

/** A 0/1 flag ("0", "1", 0, 1, false, true), or null. */
function readFlag(value) {
  if (value === '1' || value === 1 || value === true || value === 'true') return true;
  if (value === '0' || value === 0 || value === false || value === 'false') return false;
  return null;
}

/** A digits-only id as a string, or null. */
function readDigits(value, pattern = /^\d{1,9}$/) {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  return typeof text === 'string' && pattern.test(text.trim()) ? text.trim() : null;
}

// --- Train Tracker -------------------------------------------------------------

/** Error codes of Train Tracker, grouped. */
const TRAIN_UNKNOWN_ID = [103, 104, 108, 112];

/** One train arrival, or `null` when it lacks what places it. */
export function readEta(item) {
  if (!isObject(item)) return null;
  const station = readDigits(item.staId, /^4\d{4}$/);
  const stop = readDigits(item.stpId, /^3\d{4}$/);
  const route = typeof item.rt === 'string' && /^[A-Za-z]{1,6}$/.test(item.rt) ? item.rt : null;
  const arrival = readChicagoTime(item.arrT);
  const generated = readChicagoTime(item.prdt);
  if (!station || !stop || !route || arrival === null || generated === null) return null;
  const flags = ['isApp', 'isSch', 'isDly', 'isFlt'].map((k) =>
    item[k] === undefined || item[k] === null ? false : readFlag(item[k]),
  );
  if (flags.includes(null)) return null;
  const [approaching, scheduled, delayed, fault] = flags;
  return {
    station,
    stop,
    route,
    run: readString(item.rn, 10),
    stationName: readString(item.staNm, 80),
    stopDescription: readString(item.stpDe, 120),
    destination: readString(item.destNm, 80),
    arrival,
    generated,
    approaching,
    scheduled,
    delayed,
    fault,
  };
}

/**
 * A Train Tracker answer: `{ ok: true, at, etas }` (`at`: its time stamp,
 * UTC ms), or `{ ok: false, kind, code? }`: `key_refused` (101), `quota`
 * (102), `stop_missing` (unknown station or stop), `server` (900),
 * `api_error` (another code), `format`, `unreadable` (an arrival that
 * cannot be read: never published short).
 */
export function readTrain(json) {
  const root = isObject(json) && isObject(json.ctatt) ? json.ctatt : null;
  if (!root) return { ok: false, kind: 'format' };
  const code = readCode(root.errCd);
  if (code === null) return { ok: false, kind: 'format' };
  if (code === 101) return { ok: false, kind: 'key_refused', code };
  if (code === 102) return { ok: false, kind: 'quota', code };
  if (TRAIN_UNKNOWN_ID.includes(code)) return { ok: false, kind: 'stop_missing', code };
  if (code === 900) return { ok: false, kind: 'server', code };
  if (code !== 0) return { ok: false, kind: 'api_error', code };
  const at = readChicagoTime(root.tmst);
  if (at === null) return { ok: false, kind: 'no_date' };
  const list = readList(root.eta);
  if (!list) return { ok: false, kind: 'format' };
  const etas = [];
  for (const item of list) {
    const eta = readEta(item);
    if (!eta) return { ok: false, kind: 'unreadable' };
    etas.push(eta);
  }
  return { ok: true, at, etas };
}

// --- Bus Tracker ---------------------------------------------------------------

/** One bus prediction, or `null` when it lacks what places it. */
export function readPrd(item) {
  if (!isObject(item)) return null;
  const stop = readDigits(item.stpid, /^\d{1,6}$/);
  const route = typeof item.rt === 'string' && /^[A-Za-z0-9]{1,6}$/.test(item.rt) ? item.rt : null;
  const time = readChicagoTime(item.prdtm);
  const generated = readChicagoTime(item.tmstmp);
  if (!stop || !route || time === null || generated === null) return null;
  const delayed = item.dly === undefined || item.dly === null ? false : readFlag(item.dly);
  if (delayed === null) return null;
  let dyn = 0;
  if (item.dyn !== undefined && item.dyn !== null) {
    dyn = readCode(item.dyn);
    if (dyn === null) return null;
  }
  return {
    stop: String(Number(stop)),
    route,
    label: readString(item.rtdd, 10) || route,
    direction: readString(item.rtdir, 40),
    destination: readString(item.des, 80),
    stopName: readString(item.stpnm, 80),
    vehicle: readString(item.vid, 12),
    trip: readString(item.tatripid, 40),
    time,
    generated,
    delayed,
    dyn,
    // Canceled or drop-off only: nobody boards it.
    skip: BUS_SKIP_DYN.includes(dyn),
  };
}

const BUS_REFUSED = [/invalid api access key/i, /no api access key/i, /no api access permitted/i];
const BUS_QUOTA = /transaction limit/i;
const BUS_EMPTY = [/no service scheduled/i, /no arrival times/i];
const BUS_UNKNOWN = [/no data found/i, /invalid parameter/i];
const BUS_SERVER = /internal server error/i;

/**
 * A Bus Tracker answer: `{ ok: true, prds, stops }` where `stops` maps a stop
 * id named by an error entry to `empty` (no service, no arrival time),
 * `missing` (unknown) or `error`; or `{ ok: false, kind }` for an error of
 * the whole request: `key_refused`, `quota`, `server`, `api_error`, `format`,
 * `unreadable`. An error message without a stop applies to every stop asked
 * when it says "no service" (`allEmpty`).
 */
export function readBus(json) {
  const root =
    isObject(json) && isObject(json['bustime-response']) ? json['bustime-response'] : null;
  if (!root) return { ok: false, kind: 'format' };
  const errors = readList(root.error);
  const items = readList(root.prd);
  if (!errors || !items) return { ok: false, kind: 'format' };
  const stops = new Map();
  let allEmpty = false;
  for (const entry of errors) {
    if (!isObject(entry)) return { ok: false, kind: 'format' };
    const msg = readString(entry.msg, 200);
    const stop = readDigits(entry.stpid, /^\d{1,6}$/);
    if (BUS_REFUSED.some((p) => p.test(msg))) return { ok: false, kind: 'key_refused' };
    if (BUS_QUOTA.test(msg)) return { ok: false, kind: 'quota' };
    if (BUS_SERVER.test(msg)) return { ok: false, kind: 'server' };
    const status = BUS_EMPTY.some((p) => p.test(msg))
      ? 'empty'
      : BUS_UNKNOWN.some((p) => p.test(msg))
        ? 'missing'
        : 'error';
    if (stop) stops.set(String(Number(stop)), status);
    else if (status === 'empty') allEmpty = true;
    else return { ok: false, kind: 'api_error' };
  }
  const prds = [];
  for (const item of items) {
    const prd = readPrd(item);
    if (!prd) return { ok: false, kind: 'unreadable' };
    prds.push(prd);
  }
  return { ok: true, prds, stops, allEmpty };
}

// --- Customer Alerts -----------------------------------------------------------

/** A text that may come wrapped in `{ "#cdata-section": ... }`. */
const unwrap = (value) => (isObject(value) ? value['#cdata-section'] : value);

/** The CTA site only: an alert link elsewhere is dropped. */
function readAlertUrl(value) {
  const text = readString(unwrap(value), 400);
  const m = /^https?:\/\/(www\.)?transitchicago\.com(\/[^\s]*)?$/i.exec(text);
  return m ? `https://www.transitchicago.com${m[2] ?? '/'}` : '';
}

/** One alert, or `null` when it lacks its id or its headline. */
export function readAlert(item) {
  if (!isObject(item)) return null;
  const id = readDigits(item.AlertId ?? item.AlertID, /^\d{1,12}$/);
  const headline = readString(item.Headline, 300);
  if (!id || !headline) return null;
  const score = readCode(item.SeverityScore);
  const services = readList(isObject(item.ImpactedService) ? item.ImpactedService.Service : null);
  return {
    id,
    headline,
    description: readString(item.ShortDescription, 900),
    impact: readString(item.Impact, 80),
    severity: score !== null && score <= 99 ? score : null,
    major: readFlag(item.MajorAlert) === true,
    start: readChicagoTime(item.EventStart, { dateOnly: true }),
    url: readAlertUrl(item.AlertURL),
    services: (services ?? [])
      .slice(0, 50)
      .filter(isObject)
      .map((s) => ({ type: readString(s.ServiceType, 4), id: readString(s.ServiceId, 20) })),
  };
}

/**
 * A Customer Alerts answer: `{ ok: true, at, alerts }`, or `{ ok: false,
 * kind }` (`format`, `no_date`, `unreadable`, `server` for 900, `api_error`).
 * Error code 50 ("no active alerts based on your filter criteria") is an
 * empty list.
 */
export function readAlerts(json) {
  const root = isObject(json) && isObject(json.CTAAlerts) ? json.CTAAlerts : null;
  // An unknown station id gets a `CTARoutes` envelope with code 900 (seen live).
  const other = isObject(json) && isObject(json.CTARoutes) ? json.CTARoutes : null;
  const envelope = root ?? other;
  if (!envelope) return { ok: false, kind: 'format' };
  const code = readCode(envelope.ErrorCode);
  if (code === null) return { ok: false, kind: 'format' };
  if (code === 900) return { ok: false, kind: 'server' };
  if (!root || (code !== 0 && code !== 50)) return { ok: false, kind: 'api_error', code };
  const at = readChicagoTime(root.TimeStamp);
  if (at === null) return { ok: false, kind: 'no_date' };
  if (code === 50) return { ok: true, at, alerts: [] };
  const list = readList(root.Alert);
  if (!list) return { ok: false, kind: 'format' };
  const alerts = [];
  for (const item of list) {
    const alert = readAlert(item);
    if (!alert) return { ok: false, kind: 'unreadable' };
    if (!alerts.some((a) => a.id === alert.id)) alerts.push(alert);
  }
  return { ok: true, at, alerts };
}
