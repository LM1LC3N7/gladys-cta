// -----------------------------------------------------------------------------
// What a watched station or stop sees: its departures in a Train Tracker or
// Bus Tracker answer (its id, its route filter), the minutes to wait counted
// against the time of the answer, and the texts of the device. Pure
// functions, no clock read.
// -----------------------------------------------------------------------------

import {
  ALERT_TEXT_MAX,
  HORIZON,
  LEAVING_GRACE,
  MINUTE,
  PREDICTION_STALE,
  SUMMARY_MAX,
  WINDOW_MINUTES,
} from './constants.js';
import { formatClock, t, trainRouteName } from './i18n.js';

function place(at, time) {
  const ahead = time - at;
  if (ahead < -LEAVING_GRACE || ahead > HORIZON) return null;
  return Math.max(0, Math.floor(ahead / MINUTE));
}

const byTime = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The departures of a train watch in a Train Tracker answer:
 * `{ ok: true, departures, name, station }` or `{ ok: false, kind: 'stale' }`
 * when an arrival of the watch was generated more than 10 minutes before the
 * answer (a frozen feed: nothing published).
 */
export function trainDepartures(watch, read) {
  const station = watch.id.startsWith('4');
  const routes = new Set(watch.routes);
  const departures = [];
  let name = null;
  let stationId = station ? watch.id : null;
  for (const eta of read.etas) {
    if (station ? eta.station !== watch.id : eta.stop !== watch.id) continue;
    name = name ?? (eta.stationName || null);
    stationId = stationId ?? eta.station;
    if (read.at - eta.generated > PREDICTION_STALE) return { ok: false, kind: 'stale' };
    if (routes.size > 0 && !routes.has(eta.route)) continue;
    const minutes = place(read.at, eta.arrival);
    if (minutes === null) continue;
    departures.push({
      id: `${eta.route}-${eta.run}-${eta.stop}`,
      at: eta.arrival,
      minutes,
      due: eta.approaching || minutes === 0,
      label: trainRouteName(eta.route),
      headsign: eta.destination,
      delayed: eta.delayed,
      scheduled: eta.scheduled,
    });
  }
  departures.sort(byTime);
  return { ok: true, departures, name, station: stationId };
}

/**
 * The departures of a bus watch in a Bus Tracker answer read at `at` (the
 * `Date` of the answer): `{ ok: true, departures, name, routes, seen }`
 * (`seen`: a prediction named the stop, which confirms its id), or
 * `{ ok: false, kind }` (`stale`, `stop_missing`, `stop_error`).
 */
export function busDepartures(watch, read, at) {
  const status = read.stops.get(watch.id);
  if (status === 'missing') return { ok: false, kind: 'stop_missing' };
  if (status === 'error') return { ok: false, kind: 'stop_error' };
  const routes = new Set(watch.routes);
  const departures = [];
  const seenRoutes = [];
  let name = null;
  let seen = false;
  for (const prd of read.prds) {
    if (prd.stop !== watch.id) continue;
    seen = true;
    name = name ?? (prd.stopName || null);
    if (at - prd.generated > PREDICTION_STALE) return { ok: false, kind: 'stale' };
    if (routes.size > 0 && !routes.has(prd.route.toUpperCase())) continue;
    if (!seenRoutes.includes(prd.route)) seenRoutes.push(prd.route);
    if (prd.skip) continue;
    const minutes = place(at, prd.time);
    if (minutes === null) continue;
    departures.push({
      id: `${prd.route}-${prd.vehicle}-${prd.trip}`,
      at: prd.time,
      minutes,
      due: minutes === 0,
      label: prd.label,
      headsign: prd.destination,
      delayed: prd.delayed,
      scheduled: false,
    });
  }
  departures.sort(byTime);
  return { ok: true, departures, name, routes: seenRoutes, seen };
}

/** The departures counted on the counter: within the next 30 minutes. */
export const countWithin = (departures) =>
  departures.filter((d) => d.minutes < WINDOW_MINUTES).length;

const bound = (text, max) => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

const groupLabel = (d) => (d.headsign ? `${d.label} → ${d.headsign}` : d.label);

/**
 * The summary text: the read time (so that a summary left behind by a
 * failed read shows its age), then the departures by route and destination:
 * `"05:14 · Green Line → Harlem/Lake 3, 9 min · Brown Line → Kimball 12 min"`.
 */
export function summary(departures, at, language) {
  const head = formatClock(at);
  if (departures.length === 0) return `${head} · ${t(language, 'noDeparture')}`;
  const shown = departures.filter((d) => d.minutes < WINDOW_MINUTES);
  if (shown.length === 0) {
    const first = departures[0];
    return bound(
      `${head} · ${t(language, 'nextIn', { label: groupLabel(first), minutes: first.minutes })}`,
      SUMMARY_MAX,
    );
  }
  const groups = new Map();
  for (const d of shown) {
    const key = `${d.label}\u0000${d.headsign}`;
    if (!groups.has(key)) groups.set(key, { label: groupLabel(d), minutes: [] });
    const group = groups.get(key);
    if (group.minutes.length < 3) group.minutes.push(d.minutes);
  }
  const parts = [...groups.values()].map((g) => `${g.label} ${g.minutes.join(', ')} min`);
  return bound(`${head} · ${parts.join(' · ')}`, SUMMARY_MAX);
}

/**
 * The text of the next or the following departure, with its clock time (so
 * that a text left behind by a failed read still tells the truth):
 * `"Red Line → Howard in 4 min (08:09, delayed)"`. Without that departure:
 * `"No following departure (read 08:05)"`, never a number.
 */
export function departureText(d, at, language, which = 'next') {
  if (!d) {
    return t(language, which === 'next' ? 'noNext' : 'noSecond', { clock: formatClock(at) });
  }
  const label = groupLabel(d);
  const notes = [formatClock(d.at)];
  if (d.delayed) notes.push(t(language, 'delayed'));
  if (d.scheduled) notes.push(t(language, 'scheduled'));
  const clock = notes.join(', ');
  return bound(
    d.due
      ? t(language, 'due', { label, clock })
      : t(language, 'departsIn', { label, minutes: d.minutes, clock }),
    SUMMARY_MAX,
  );
}

/** The alerts sorted: major first, then the most severe, then the newest id. */
export function sortAlerts(alerts) {
  return [...alerts].sort(
    (a, b) =>
      Number(b.major) - Number(a.major) ||
      (b.severity ?? -1) - (a.severity ?? -1) ||
      Number(b.id) - Number(a.id),
  );
}

/** The alert text of the device: the first alert, and how many more. */
export function alertText(alerts, language) {
  if (alerts.length === 0) return t(language, 'noAlert');
  const [top] = sortAlerts(alerts);
  const more =
    alerts.length > 1 ? ` (${t(language, 'moreAlerts', { count: alerts.length - 1 })})` : '';
  return bound(`${top.headline}${more}`, ALERT_TEXT_MAX);
}
