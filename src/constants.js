// -----------------------------------------------------------------------------
// The fixed values of the integration: the three APIs of the CTA Developer
// Center, their pace and daily quotas, the bounds of what is read, and the
// keys shared with the manifest.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of the package (the release bumps it): the User-Agent follows. */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** Train Tracker arrivals (key of the Train Tracker API). */
export const TRAIN_URL = 'https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx';
/** Bus Tracker predictions, version 3 (key of the Bus Tracker API). */
export const BUS_URL = 'https://www.ctabustracker.com/bustime/api/v3/getpredictions';
/** Customer Alerts (no key). */
export const ALERTS_URL = 'https://www.transitchicago.com/api/1.0/alerts.aspx';

/** An honest User-Agent naming the integration, never a browser's. */
export const USER_AGENT = `gladys-cta/${VERSION} (+https://github.com/LM1LC3N7/gladys-cta)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** One request at a time, 1 s at least between the starts of two (any host). */
export const REQUEST_GAP = SECOND;
/** One request never lasts longer (connection, answer and body). */
export const REQUEST_TIMEOUT = 15 * SECOND;
/** A body larger than this is cut before it is read in full (memory bound). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Items read per answer at most; a longer list is refused (never cut). */
export const MAX_ITEMS = 500;

/** The read interval of the departures, in seconds (config `refresh_seconds`). */
export const REFRESH_DEFAULT = 60;
export const REFRESH_MIN = 30;
export const REFRESH_MAX = 600;

/**
 * The daily budget of each key, in requests (config `daily_budget`). The CTA
 * grants 100,000 requests a day per key by default (Train Tracker and Bus
 * Tracker docs, read on 2026-11-27); the integration keeps far under it, so
 * that the same key can serve something else.
 */
export const BUDGET_DEFAULT = 10000;
export const BUDGET_MIN = 500;
export const BUDGET_MAX = 100000;
/** The planned rounds use at most this share of the budget (room for the button). */
export const BUDGET_SHARE = 0.9;

/** The alerts are read every 5 minutes (a round within 5 s of it counts). */
export const ALERTS_INTERVAL = 5 * MINUTE;
export const ALERTS_SLACK = 5 * SECOND;
/** A failed alerts read is retried later, doubled, bounded. */
export const ALERTS_RETRY_MAX = HOUR;
/** A stop or station the CTA does not know is asked again after this. */
export const MISSING_RETRY = 30 * MINUTE;

/** Pauses after a 429 and a server error, doubled each time, bounded. */
export const PAUSE_429_FIRST = 2 * MINUTE;
export const PAUSE_5XX_FIRST = MINUTE;
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The CTA says the daily limit of a key is reached: at least this pause. */
export const QUOTA_PAUSE_MIN = HOUR;
/** After the local midnight of Chicago, the new day of a quota starts this late. */
export const QUOTA_RESET_MARGIN = 5 * MINUTE;

/** `getConfig()` failing on a connection: retried forever, spaced out. */
export const CONFIG_RETRY_FIRST = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;

/**
 * A server `Date` further than this from the local clock is not believed: the
 * local clock is wrong, or the answer is an old copy. Nothing is published.
 */
export const CLOCK_SKEW = 5 * MINUTE;
/** The time stamp inside an answer must be this close to its `Date`. */
export const STAMP_SKEW = 3 * MINUTE;
/** A prediction generated longer ago than this: the feed is frozen. */
export const PREDICTION_STALE = 10 * MINUTE;
/** Departures counted on the counter: within this window. */
export const WINDOW_MINUTES = 30;
/** A departure further than this is ignored (an absurd time). */
export const HORIZON = 3 * HOUR;
/** A departure up to this much in the past is "due" (0 min). */
export const LEAVING_GRACE = MINUTE;

/** Alert ids remembered per watch (scene trigger), and for how long. */
export const SEEN_MAX = 500;
export const SEEN_KEEP = 7 * DAY;
/** Scene events fired per watch and per read, at most. */
export const SCENE_EVENTS_PER_READ = 10;
/** An alert is announced when it started within this before the read. */
export const FRESH_ALERT = DAY;

/** Watched train stations and bus stops (one Gladys device each). */
export const TRAIN_SLOTS = [1, 2, 3, 4];
export const BUS_SLOTS = [1, 2, 3, 4];
export const ROUTES_MAX = 8;
export const NAME_MAX = 60;
/** A station (40000-49999) or a platform stop (30000-39999) of the 'L'. */
export const TRAIN_ID = /^[34]\d{4}$/;
/** A bus stop id of Bus Tracker. */
export const BUS_ID = /^\d{1,6}$/;
/** A bus route designator ("20", "X9", "J14"). */
export const BUS_ROUTE = /^[A-Za-z0-9]{1,6}$/;
/** An API key: letters and digits only (never echoed, never logged). */
export const KEY_PATTERN = /^[A-Za-z0-9]{8,64}$/;

/** The 'L' routes of Train Tracker, with the names a user may type. */
export const TRAIN_ROUTES = Object.freeze({
  Red: { name: 'Red Line', aliases: ['red'] },
  Blue: { name: 'Blue Line', aliases: ['blue'] },
  Brn: { name: 'Brown Line', aliases: ['brn', 'brown'] },
  G: { name: 'Green Line', aliases: ['g', 'green'] },
  Org: { name: 'Orange Line', aliases: ['org', 'orange'] },
  P: { name: 'Purple Line', aliases: ['p', 'purple', 'pexp'] },
  Pink: { name: 'Pink Line', aliases: ['pink'] },
  Y: { name: 'Yellow Line', aliases: ['y', 'yellow'] },
});

/**
 * Bus predictions that are not departures (Bus Tracker guide v3, dynamic
 * action types): canceled (1), drop-off only (4), canceled without showing
 * the cancellation (12: kept out, the safe side), invalidated trips (16, 17:
 * "predictions should not be shown to the public"), canceled new trip (18).
 */
export const BUS_SKIP_DYN = Object.freeze([1, 4, 12, 16, 17, 18]);

/** Counters are bounded. */
export const COUNT_MAX = MAX_ITEMS;
/** The texts published on the device, in characters. */
export const SUMMARY_MAX = 600;
export const ALERT_TEXT_MAX = 600;
/** The texts handed to a scene (the core accepts 1000 characters). */
export const SCENE_TEXT_MAX = 900;

export const KINDS = Object.freeze(['train', 'bus']);
export const FEATURES = Object.freeze({
  NEXT: 'next',
  SECOND: 'second',
  DEPARTURES: 'departures',
  SUMMARY: 'summary',
  ALERTS: 'alerts',
  ALERT_TEXT: 'alert_text',
});

export const ACTIONS = Object.freeze({ TEST: 'test' });
export const SCENE_TRIGGER = 'new_alert';

/** The time zone of the CTA: its APIs give local times without offset. */
export const TIME_ZONE = 'America/Chicago';

export const STATE_FILE = '/data/cta-state.json';
