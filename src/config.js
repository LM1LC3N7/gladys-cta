// -----------------------------------------------------------------------------
// The configuration filled in by the user, read strictly: an empty field is
// absent (never 0), a number is a plain decimal, an id holds only what the
// CTA uses in its ids. A refused field is named by its key, never echoed
// back; a key is never echoed, logged nor kept anywhere but in memory.
// -----------------------------------------------------------------------------

import {
  BUDGET_DEFAULT,
  BUDGET_MAX,
  BUDGET_MIN,
  BUS_ID,
  BUS_ROUTE,
  BUS_SLOTS,
  KEY_PATTERN,
  NAME_MAX,
  REFRESH_DEFAULT,
  REFRESH_MAX,
  REFRESH_MIN,
  ROUTES_MAX,
  TRAIN_ID,
  TRAIN_ROUTES,
  TRAIN_SLOTS,
} from './constants.js';

export const LANGUAGES = ['en', 'fr'];

// Any control character (C0, DEL, C1): never in a name, an id or a key.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The keys of the fields of a watched station or stop (manifest `config_schema`). */
export const watchKeys = (kind, slot) => ({
  name: `${kind}${slot}_name`,
  id: `${kind}${slot}_${kind === 'train' ? 'station' : 'stop'}`,
  routes: `${kind}${slot}_routes`,
});

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * A number typed by the user: `null` when blank, `NaN` when not a plain
 * decimal (`Number('')` is 0, `Number('1e3')` 1000: both refused here).
 */
export function readNumber(value) {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  return /^[-+]?\d{1,7}(\.\d{1,6})?$/.test(text) ? Number(text) : NaN;
}

/** A whole number in a range: the default when blank, `undefined` when refused. */
function readInteger(value, min, max, fallback) {
  const number = readNumber(value);
  if (number === null) return fallback;
  if (Number.isNaN(number) || !Number.isInteger(number) || number < min || number > max) {
    return undefined;
  }
  return number;
}

/** A free text: `null` when blank, `undefined` when refused (control byte). */
function readText(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string' || CONTROL.test(value)) return undefined;
  return value.trim().replace(/\s+/g, ' ');
}

/** An API key: `null` when blank, `undefined` when refused (never echoed). */
export function readKey(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  return KEY_PATTERN.test(key) ? key : undefined;
}

/** The id of a train route typed by the user ("Red", "brown", "Brn"), or null. */
export function trainRouteId(text) {
  const key = text.toLowerCase();
  for (const [id, route] of Object.entries(TRAIN_ROUTES)) {
    if (id.toLowerCase() === key || route.aliases.includes(key)) return id;
  }
  return null;
}

/** Route ids, comma or semicolon separated, unique, bounded. */
export function readRoutes(kind, value) {
  if (isBlank(value)) return { routes: [] };
  if (typeof value !== 'string' || CONTROL.test(value)) return { error: 'routes_invalid' };
  const routes = [];
  for (const part of value.split(/[,;]/)) {
    const text = part.trim();
    if (!text) continue;
    let route;
    if (kind === 'train') {
      route = trainRouteId(text);
      if (!route) return { error: 'train_route_invalid' };
    } else {
      if (!BUS_ROUTE.test(text)) return { error: 'routes_invalid' };
      route = text.toUpperCase();
    }
    if (!routes.includes(route)) routes.push(route);
  }
  if (routes.length > ROUTES_MAX) return { error: 'routes_too_many' };
  return { routes };
}

function readWatch(raw, kind, slot) {
  const keys = watchKeys(kind, slot);
  const value = raw[keys.id];
  if (isBlank(value)) return {};
  const errors = [];
  const id = typeof value === 'number' ? String(value) : String(value).trim();
  if (!(kind === 'train' ? TRAIN_ID : BUS_ID).test(id)) {
    errors.push({ field: keys.id, code: kind === 'train' ? 'station_invalid' : 'stop_invalid' });
  }
  const routes = readRoutes(kind, raw[keys.routes]);
  if (routes.error) errors.push({ field: keys.routes, code: routes.error });
  const name = readText(raw[keys.name]);
  if (name === undefined || (name && [...name].length > NAME_MAX)) {
    errors.push({ field: keys.name, code: 'name_invalid' });
  }
  if (errors.length > 0) return { errors };
  // A bus stop id is a number: "0456" and "456" are the same stop.
  const canonical = kind === 'bus' ? String(Number(id)) : id;
  return {
    watch: { kind, slot, id: canonical, name: name || null, routes: routes.routes },
    errors: [],
  };
}

/**
 * The configuration the app runs with. `watches` holds the valid ones only;
 * `errors` names each refused field (never its value). A refused key counts
 * as no key: its watches say so, nothing is sent with it.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const language = LANGUAGES.includes(source.language) ? source.language : 'en';
  let refreshSeconds = readInteger(source.refresh_seconds, REFRESH_MIN, REFRESH_MAX, null);
  if (refreshSeconds === undefined) {
    errors.push({ field: 'refresh_seconds', code: 'refresh' });
  }
  refreshSeconds = refreshSeconds ?? REFRESH_DEFAULT;
  let dailyBudget = readInteger(source.daily_budget, BUDGET_MIN, BUDGET_MAX, null);
  if (dailyBudget === undefined) errors.push({ field: 'daily_budget', code: 'budget' });
  dailyBudget = dailyBudget ?? BUDGET_DEFAULT;
  const keys = {};
  for (const [kind, field] of [
    ['train', 'train_key'],
    ['bus', 'bus_key'],
  ]) {
    const key = readKey(source[field]);
    if (key === undefined) errors.push({ field, code: 'key_invalid' });
    keys[kind] = key ?? null;
  }
  const watches = [];
  for (const [kind, slots] of [
    ['train', TRAIN_SLOTS],
    ['bus', BUS_SLOTS],
  ]) {
    for (const slot of slots) {
      const result = readWatch(source, kind, slot);
      if (result.watch) watches.push(result.watch);
      errors.push(...(result.errors ?? []));
    }
  }
  return { language, refreshSeconds, dailyBudget, keys, watches, errors };
}

/** The key of a watch in the maps and in /data: `train1`, `bus3`. */
export const watchKey = (watch) => `${watch.kind}${watch.slot}`;
