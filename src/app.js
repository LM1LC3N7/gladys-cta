// -----------------------------------------------------------------------------
// The integration: reads the next trains (Train Tracker) and buses (Bus
// Tracker) at each watched station or stop, and the alerts in effect there
// (Customer Alerts), publishes what each one sees, fires the "new alert"
// scene trigger, and tells in the status exactly where each stands.
//
// Pace and courtesy toward the CTA:
//   - one request at a time, 1 s at least between the starts of two;
//   - per round: one Train Tracker request per station, one Bus Tracker
//     request for every bus stop; the alerts every 5 minutes, one request per
//     station or stop (no key);
//   - each key has a daily budget (10,000 requests by default, the CTA grants
//     100,000): the requests of the day are counted per Chicago date and the
//     count reaches /data before each request, so a restart keeps it; the
//     interval is stretched when the planned rounds would not fit 90 % of the
//     budget, and a spent budget stops that key until the next day;
//   - the period is measured from the start of a round, never shorter than
//     the interval: neither a restart (the time of the last attempt is in
//     /data, written before the round), nor a reconnection, a saved but
//     unchanged configuration, Discovery or the button reads sooner;
//   - a 429, a 5xx or an unexpected status pauses that service (bounded,
//     doubled, kept in /data); "daily limit reached" pauses the key until
//     the next Chicago day; a refused key is never sent again until it
//     changes or the button's retry succeeds (a salted 8-bit print in /data,
//     never the key).
//
// Never a value without proof: a departure is counted against the time of
// the answer that carries it; a failed, stale or unreadable read publishes
// nothing (never 0), and the status says since when.
//
// Clocks: the decisions (gap, pause, period) use the monotonic clock, read
// once per decision; the wall clock serves /data (restart), the Chicago date
// of the daily quotas and the times shown.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import {
  ALERTS_INTERVAL,
  ALERTS_RETRY_MAX,
  ALERTS_SLACK,
  BUDGET_MAX,
  BUDGET_SHARE,
  CLOCK_SKEW,
  CONFIG_RETRY_FIRST,
  CONFIG_RETRY_MAX,
  DAY,
  FEATURES,
  FRESH_ALERT,
  MINUTE,
  MISSING_RETRY,
  PAUSE_429_FIRST,
  PAUSE_5XX_FIRST,
  PAUSE_MAX,
  PAUSE_MIN,
  QUOTA_PAUSE_MIN,
  QUOTA_RESET_MARGIN,
  REFRESH_MIN,
  REQUEST_GAP,
  SCENE_EVENTS_PER_READ,
  SCENE_TEXT_MAX,
  SCENE_TRIGGER,
  SECOND,
  SEEN_KEEP,
  SEEN_MAX,
  STAMP_SKEW,
} from './constants.js';
import { normalizeConfig, watchKey } from './config.js';
import { alertsUrl, busUrl, getJson, readAlerts, readBus, readTrain, trainUrl } from './cta.js';
import { buildDevices, isWatchDevice, watchIds } from './devices.js';
import { M, configErrors, failure, formatTime, serviceName, watchLabel } from './i18n.js';
import { createFileStore } from './store.js';
import { chicagoDay, nextChicagoMidnight } from './time.js';
import {
  alertText,
  busDepartures,
  countWithin,
  departureText,
  sortAlerts,
  summary,
  trainDepartures,
} from './watch.js';

const SAVE_BOUND = 2 * SECOND;
/** An unreadable /data is read again this often. */
const RELOAD_DELAY = 10 * SECOND;
const GLADYS_BOUND = 10 * SECOND;
const STATUS_MAX = 1500;
const LANGS = ['en', 'fr'];
const KEYED = ['train', 'bus'];
const SERVICES = ['train', 'bus', 'alerts'];
/** A persisted pause longer than this is not believed (a quota pause lasts a day at most). */
const PAUSE_BELIEVED = DAY + 2 * PAUSE_MAX;
const PAUSE_KINDS = ['rate', 'server', 'http', 'api_error', 'quota'];

const isTime = (value) => Number.isFinite(value) && value > 0;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CtaApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    urls = {},
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.urls = urls;

    /** Bumped by every start and stop: an older round goes quiet. */
    this.gen = 0;
    /** Bumped by every connection and disconnection (config retry loop). */
    this.connGen = 0;
    this.config = null;
    this.interval = null;
    this.cycleTimer = null;
    this.reloadTimer = null;
    this.sleeps = new Set();
    this.pendingStart = undefined;
    this.starting = null;

    this.lastRequestMono = -Infinity;
    this.inflight = null;
    /** Per service: the monotonic end of its pause, or null. */
    this.pauseUntilMono = { train: null, bus: null, alerts: null };
    /** Per keyed service: the monotonic time of its last request (button spacing). */
    this.lastServiceMono = { train: null, bus: null };
    /** Per keyed service: the key the CTA last accepted in this process. */
    this.accepted = {};
    /** The keyed service the button retries (its refused key may go once). */
    this.probing = null;
    this.nextDueMono = null;
    this.lastStatus = null;
    this.lastFingerprints = null;
    this.lastKeys = null;
    this.publishedNames = null;
    /** Whether a round (or the button's retry) runs. */
    this.inRound = false;

    /** Per watch: `{ fingerprint, name, station, routes }`, what the CTA told of it. */
    this.learnt = new Map();
    /** Per watch: `{ fingerprint, mono }`, an id the CTA does not know (asked again later). */
    this.missing = new Map();
    /** Per watch: `{ dueMono, level }` of the next alerts read. */
    this.alertsDue = new Map();
    /** Per watch: `{ fingerprint, dep, alerts }`, what the status tells. */
    this.results = new Map();

    this.loaded = false;
    this.storeStatus = 'absent';
    this.persisted = this.emptyState();

    /** The start of the process, and the last round started in it. */
    this.startMono = this.monotonic();
    this.lastAttemptMono = null;
    /** Whether /data tells the last attempt (null: not known yet). */
    this.dataTells = null;
    this.saveFailed = false;
  }

  emptyState() {
    return {
      salt: randomBytes(16).toString('hex'),
      quota: {},
      refused: {},
      pause: {},
      confirmed: {},
      watches: {},
    };
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * A connection to Gladys: read the configuration, then start. A failing
   * `getConfig()` is retried forever, spaced out (5 s doubled up to 5 min),
   * with the status saying so.
   */
  async connected() {
    const conn = ++this.connGen;
    // A new connection: Gladys gets the status again, even unchanged.
    this.lastStatus = null;
    let delay = CONFIG_RETRY_FIRST;
    for (;;) {
      let raw;
      try {
        raw = await this.bounded(() => this.gladys.getConfig());
      } catch (err) {
        if (conn !== this.connGen) return;
        this.logger.warn(
          `Configuration not read (${err?.name ?? 'Error'}); retry in ${delay / SECOND} s`,
        );
        await this.setStatus(
          false,
          M.configRetry({ seconds: Math.round(delay / SECOND) }),
          this.gen,
        );
        await this.sleep(delay);
        if (conn !== this.connGen) return;
        delay = Math.min(delay * 2, CONFIG_RETRY_MAX);
        continue;
      }
      if (conn !== this.connGen) return;
      await this.start(raw);
      return;
    }
  }

  async disconnected() {
    this.connGen += 1;
    await this.stop();
  }

  /**
   * Apply a configuration. Configurations saved in a row apply one after the
   * other, the last one winning.
   */
  start(raw) {
    this.pendingStart = { raw };
    if (!this.starting) {
      this.starting = (async () => {
        try {
          while (this.pendingStart) {
            const { raw: next } = this.pendingStart;
            this.pendingStart = undefined;
            await this.applyConfig(next);
          }
        } finally {
          this.starting = null;
        }
      })();
    }
    return this.starting;
  }

  async stop() {
    this.gen += 1;
    this.cancelTimers();
    await this.persist();
  }

  /** Waits for the start in progress and the request in flight (tests). */
  async idle() {
    while (this.starting || this.inflight) {
      await this.starting;
      await this.inflight;
    }
  }

  cancelTimers() {
    if (this.cycleTimer) this.timers.clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    if (this.reloadTimer) this.timers.clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    for (const sleep of this.sleeps) {
      this.timers.clearTimeout(sleep.timer);
      sleep.resolve();
    }
    this.sleeps.clear();
  }

  /** A wait on the injected timers, released at once by a stop. */
  sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve };
      entry.timer = this.timers.setTimeout(
        () => {
          this.sleeps.delete(entry);
          resolve();
        },
        Math.max(0, ms),
      );
      this.sleeps.add(entry);
    });
  }

  /**
   * The interval of the rounds, in ms: the one configured, stretched when the
   * planned requests of a key would not fit 90 % of its daily budget.
   */
  plannedInterval(config) {
    let seconds = config.refreshSeconds;
    const perRound = {
      train: config.watches.filter((w) => w.kind === 'train').length,
      bus: config.watches.some((w) => w.kind === 'bus') ? 1 : 0,
    };
    for (const service of KEYED) {
      if (perRound[service] === 0 || !config.keys[service]) continue;
      const needed = Math.ceil((86400 * perRound[service]) / (config.dailyBudget * BUDGET_SHARE));
      seconds = Math.max(seconds, needed);
    }
    return seconds * SECOND;
  }

  async applyConfig(raw) {
    this.gen += 1;
    const gen = this.gen;
    this.cancelTimers();
    const config = normalizeConfig(raw);
    this.config = config;
    this.interval = this.plannedInterval(config);
    this.load();
    this.scheduleReload(gen);
    for (const error of config.errors) {
      this.logger.warn(`Configuration: field ${error.field} refused (${error.code})`);
    }
    // A key changed since the previous configuration: a refusal of the old
    // one never holds the new one.
    if (this.lastKeys) {
      for (const service of KEYED) {
        if (this.lastKeys[service] !== config.keys[service]) {
          this.persisted.refused[service] = null;
          this.pauseUntilMono[service] = null;
          delete this.persisted.pause[service];
        }
      }
    }
    this.lastKeys = { ...config.keys };
    await this.publishDevices();
    if (gen !== this.gen) return;
    if (config.watches.length === 0) {
      const errors = configErrors(config.errors);
      await this.setStatus(
        false,
        { en: `${M.noWatch.en} ${errors.en}`.trim(), fr: `${M.noWatch.fr} ${errors.fr}`.trim() },
        gen,
      );
      return;
    }
    // Forget what the changed watches saw; keep what the others saw.
    const fingerprints = new Map(
      config.watches.map((watch) => [watchKey(watch), this.fingerprint(watch)]),
    );
    for (const map of [this.results, this.learnt, this.missing]) {
      for (const [key, entry] of [...map]) {
        if (entry.fingerprint !== fingerprints.get(key)) map.delete(key);
      }
    }
    if (this.dataTells === null) await this.checkData();
    if (gen !== this.gen) return;
    const changed =
      this.lastFingerprints !== null &&
      JSON.stringify([...fingerprints]) !== JSON.stringify([...this.lastFingerprints]);
    this.lastFingerprints = fingerprints;
    if (changed) this.alertsDue.clear();

    // When is the first round due? One clock read for the decision.
    const wall = this.now();
    const mono = this.monotonic();
    let wait = 0;
    const last = this.persisted.lastAttemptAt;
    if (!changed) {
      if (this.lastAttemptMono !== null) {
        // A round already ran in this process: its monotonic time decides.
        wait = Math.max(0, this.lastAttemptMono + this.interval - mono);
      } else if (!this.dataTells) {
        // /data cannot tell the last attempt: a restart never reads at once.
        wait = Math.max(0, this.startMono + REFRESH_MIN * SECOND - mono);
      } else if (isTime(last)) {
        wait = Math.max(0, last + this.interval - wall);
      }
    }
    for (const service of SERVICES) {
      const pause = this.persisted.pause[service];
      if (!pause || !isTime(pause.until) || pause.until <= wall) continue;
      if (pause.until - wall > PAUSE_BELIEVED) continue;
      const until = mono + (pause.until - wall);
      if (this.pauseUntilMono[service] === null || this.pauseUntilMono[service] < until) {
        this.pauseUntilMono[service] = until;
      }
    }
    this.nextDueMono = mono + wait;
    await this.updateStatus(gen);
    if (gen !== this.gen) return;
    this.scheduleCycle(Math.min(wait, this.interval), gen);
  }

  /**
   * Whether /data tells when the CTA was last read: readable, with no date in
   * the future, and writable (checked by writing it back before any read).
   */
  async checkData() {
    const last = this.persisted.lastAttemptAt;
    if (this.storeStatus === 'unreadable') this.dataTells = false;
    else if (isTime(last) && last > this.now()) {
      this.logger.warn('The last attempt in /data is in the future: not believed');
      this.dataTells = false;
    } else {
      // Readable is not enough: a /data that cannot be written would keep an
      // old attempt time and let every restart read.
      this.dataTells = await this.persist();
      if (!this.dataTells) this.saveFailed = true;
    }
  }

  scheduleCycle(delay, gen) {
    if (gen !== this.gen) return;
    if (this.cycleTimer) this.timers.clearTimeout(this.cycleTimer);
    this.cycleTimer = this.timers.setTimeout(
      () => {
        this.cycleTimer = null;
        this.runCycle(gen).catch((err) => {
          this.logger.error(`Read failed (${err?.name ?? 'Error'})`);
          // Never left without a next round: armed again at the interval.
          if (gen === this.gen && this.config) {
            this.nextDueMono = this.monotonic() + this.interval;
            this.scheduleCycle(this.interval, gen);
          }
        });
      },
      Math.max(0, delay),
    );
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    const { status, persisted } = this.readStore();
    this.storeStatus = status;
    if (status === 'unreadable') {
      this.logger.warn(
        'The state file of /data is unreadable: left untouched, running from memory',
      );
    }
    this.persisted = persisted;
  }

  /** One read of /data, checked field by field: `{ status, persisted }`. */
  readStore() {
    let result;
    try {
      result = this.store.load();
    } catch {
      result = { status: 'unreadable', data: {} };
    }
    const data = result.status === 'unreadable' ? {} : (result.data ?? {});
    const persisted = this.emptyState();
    const object = (value) =>
      value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt))
      persisted.salt = data.salt;
    if (isTime(data.lastAttemptAt)) persisted.lastAttemptAt = data.lastAttemptAt;
    const today = chicagoDay(this.now());
    const tomorrow = chicagoDay(this.now() + DAY);
    for (const service of KEYED) {
      const q = object(data.quota)[service];
      if (
        q &&
        typeof q.day === 'string' &&
        DAY_PATTERN.test(q.day) &&
        // A day after tomorrow is not believed (a wrong clock wrote it).
        q.day <= tomorrow &&
        Number.isInteger(q.count) &&
        q.count >= 0 &&
        q.count <= 2 * BUDGET_MAX &&
        typeof q.key === 'string' &&
        /^[0-9a-f]{2}$/.test(q.key)
      ) {
        persisted.quota[service] = q.day < today ? { ...q, day: today, count: 0 } : { ...q };
      }
      const r = object(data.refused)[service];
      if (typeof r === 'string' && /^[0-9a-f]{2}$/.test(r)) persisted.refused[service] = r;
    }
    for (const service of SERVICES) {
      const p = object(data.pause)[service];
      if (!p || typeof p !== 'object') continue;
      const level = (n) => (Number.isInteger(n) && n >= 0 && n <= 30 ? n : 0);
      persisted.pause[service] = {
        until: isTime(p.until) ? p.until : null,
        kind: PAUSE_KINDS.includes(p.kind) ? p.kind : 'rate',
        status: Number.isInteger(p.status) && p.status >= 100 && p.status <= 599 ? p.status : null,
        level429: level(p.level429),
        level5xx: level(p.level5xx),
      };
    }
    for (const [key, print] of Object.entries(object(data.confirmed))) {
      if (
        /^(train|bus)[1-4]$/.test(key) &&
        typeof print === 'string' &&
        /^[0-9a-f]{32}$/.test(print)
      ) {
        persisted.confirmed[key] = print;
      }
    }
    for (const [key, watch] of Object.entries(object(data.watches))) {
      if (!/^(train|bus)[1-4]$/.test(key) || !watch || typeof watch.fingerprint !== 'string') {
        continue;
      }
      const seen = {};
      for (const [id, at] of Object.entries(object(watch.seen)).slice(0, SEEN_MAX)) {
        if (/^\d{1,12}$/.test(id) && isTime(at)) seen[id] = at;
      }
      persisted.watches[key] = { fingerprint: watch.fingerprint, seen };
    }
    return { status: result.status, persisted };
  }

  /**
   * An unreadable /data is read again every 10 s, one read at a time, on its
   * own timer (never on the path of a read or of the button). Once readable,
   * its state and the memory's are merged on the safe side.
   */
  scheduleReload(gen) {
    if (this.storeStatus !== 'unreadable' || this.reloadTimer || gen !== this.gen) return;
    this.reloadTimer = this.timers.setTimeout(() => {
      this.reloadTimer = null;
      if (gen !== this.gen) return;
      const { status, persisted } = this.readStore();
      if (status === 'unreadable') {
        this.scheduleReload(gen);
        return;
      }
      this.adopt(persisted);
      this.storeStatus = status;
      this.logger.info('The state file of /data is readable again: merged');
      this.persist().catch(() => {});
    }, RELOAD_DELAY);
  }

  /**
   * Takes the state read from /data (and its salt), keeping what memory
   * learnt meanwhile: the larger count of the day, the later pause, a refusal
   * seen in memory, a refusal of the file lifted by a success in memory.
   */
  adopt(file) {
    const mem = this.persisted;
    const config = this.config;
    const wall = this.now();
    const today = chicagoDay(wall);
    const memPrint = (service) => this.keyPrint(config?.keys[service]);
    const memFingerprints = new Map(
      (config?.watches ?? []).map((w) => [watchKey(w), this.fingerprint(w)]),
    );
    const before = Object.fromEntries(KEYED.map((s) => [s, memPrint(s)]));
    this.persisted = file;
    for (const service of KEYED) {
      const key = config?.keys[service];
      const print = this.keyPrint(key);
      const count = (q, p) => (q && q.key === p && q.day === today ? q.count : 0);
      const most = Math.max(
        count(mem.quota[service], before[service]),
        count(file.quota[service], print),
      );
      if (key) file.quota[service] = { day: today, count: most, key: print };
      if (key && mem.refused[service] && mem.refused[service] === before[service]) {
        file.refused[service] = print;
      } else if (key && this.accepted[service] === key) {
        // The CTA accepted the current key in this process: the refusal is old.
        file.refused[service] = null;
      }
    }
    for (const service of SERVICES) {
      const m = mem.pause[service];
      const f = file.pause[service];
      if (m && isTime(m.until) && (!f || !isTime(f.until) || f.until < m.until))
        file.pause[service] = m;
    }
    if (isTime(mem.lastAttemptAt) && !(file.lastAttemptAt >= mem.lastAttemptAt)) {
      file.lastAttemptAt = mem.lastAttemptAt;
    }
    // The maps of memory follow the salt of the file.
    for (const watch of config?.watches ?? []) {
      const key = watchKey(watch);
      const next = this.fingerprint(watch);
      for (const map of [this.results, this.learnt, this.missing]) {
        const entry = map.get(key);
        if (entry && entry.fingerprint === memFingerprints.get(key)) entry.fingerprint = next;
      }
      if (mem.confirmed[key] === memFingerprints.get(key)) file.confirmed[key] = next;
      this.lastFingerprints?.set(key, next);
    }
  }

  /** A salted fingerprint of a watch: never its id in clear in /data. */
  fingerprint(watch) {
    return createHash('sha256')
      .update(JSON.stringify([this.persisted.salt, watch.kind, watch.id]))
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * A salted 8-bit print of a key: enough to tell "another key" after a
   * restart, far too short to find the key back (256 values for any key).
   */
  keyPrint(key) {
    if (!key) return null;
    return createHash('sha256')
      .update(`${this.persisted.salt}\u0000${key}`)
      .digest('hex')
      .slice(0, 2);
  }

  /**
   * A call to Gladys, never waited for more than 10 s: a Gladys that does
   * not answer never holds a round. Rejects when late, as a failed call.
   */
  async bounded(fn) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new Error('Gladys did not answer')),
        GLADYS_BOUND,
      );
    });
    try {
      return await Promise.race([Promise.resolve().then(fn), late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** Saves /data without ever waiting more than SAVE_BOUND for it. */
  async persist() {
    if (!this.loaded || this.storeStatus === 'unreadable') return false;
    let timer;
    const bound = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('late'), SAVE_BOUND);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve(this.store.save(this.persisted)).then(() => 'saved'),
        bound,
      ]);
      if (outcome === 'late') this.logger.warn('Saving /data is slow: going on without waiting');
      return outcome === 'saved';
    } catch (err) {
      this.logger.warn(`Saving /data failed (${err?.code ?? err?.name ?? 'Error'})`);
      return false;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- Discovery, button -----------------------------------------------------

  /** The CTA names of the watches learnt so far. */
  names() {
    const names = new Map();
    for (const [key, info] of this.learnt) if (info.name) names.set(key, info.name);
    return names;
  }

  async publishDevices() {
    const config = this.config ?? normalizeConfig(this.gladys.config);
    try {
      const names = this.names();
      this.publishedNames = JSON.stringify([...names]);
      await this.bounded(() =>
        this.gladys.publishDiscoveredDevices(buildDevices(this.gladys, config, names)),
      );
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  /** Discovery: the watches of the configuration, never a read. */
  scan() {
    return this.publishDevices();
  }

  /**
   * The button: what the last read of each watch gave. When the CTA refused a
   * key, it sends one request with it (counted in the budget, 30 s at least
   * after the previous one of that key): a success lifts the refusal. It
   * never reads otherwise.
   */
  async testConnection() {
    const config = this.config;
    if (!config) return M.starting;
    const refused = KEYED.filter(
      (s) => config.keys[s] && this.isRefused(s) && config.watches.some((w) => w.kind === s),
    );
    if (refused.length === 0) return this.composeStatus().message;
    if (this.inRound) return M.busy;
    const gen = this.gen;
    this.inRound = true;
    try {
      for (const service of refused) {
        if (gen !== this.gen) break;
        const last = this.lastServiceMono[service];
        if (last !== null && this.monotonic() - last < REFRESH_MIN * SECOND) continue;
        this.probing = service;
        try {
          if (service === 'train') {
            await this.readTrains(gen, [config.watches.find((w) => w.kind === 'train')]);
          } else {
            await this.readBuses(gen);
          }
        } finally {
          this.probing = null;
        }
      }
    } finally {
      this.inRound = false;
    }
    await this.persist();
    await this.updateStatus(gen);
    return this.composeStatus().message;
  }

  // --- The read round --------------------------------------------------------

  async runCycle(gen) {
    if (gen !== this.gen) return;
    const mono0 = this.monotonic();
    const left = (this.nextDueMono ?? mono0) - mono0;
    if (left > 0) {
      this.scheduleCycle(Math.min(left + 5, this.interval), gen);
      await this.updateStatus(gen);
      return;
    }
    // A round (or the button) still running: this one comes right after it.
    if (this.inRound) {
      this.scheduleCycle(SECOND, gen);
      return;
    }
    this.inRound = true;
    try {
      await this.round(gen);
    } finally {
      this.inRound = false;
    }
  }

  /** One round: the trains, the buses, the alerts when due. */
  async round(gen) {
    const start = this.monotonic();
    this.lastAttemptMono = start;
    this.nextDueMono = start + this.interval;
    // The time of the attempt is in /data before the first request.
    this.persisted.lastAttemptAt = this.now();
    // The next round is armed first: neither a slow /data nor a Gladys that
    // does not answer a publication holds it back.
    this.scheduleCycle(this.interval, gen);
    const saved = await this.persist();
    this.saveFailed = !saved && this.storeStatus !== 'unreadable';
    if (gen !== this.gen) return;
    await this.readTrains(gen);
    if (gen !== this.gen) return;
    await this.readBuses(gen);
    if (gen !== this.gen) return;
    await this.readAllAlerts(gen, start);
    if (gen !== this.gen) return;
    const savedAfter = await this.persist();
    if (this.storeStatus !== 'unreadable') this.saveFailed = this.saveFailed || !savedAfter;
    if (gen !== this.gen) return;
    if (this.publishedNames !== JSON.stringify([...this.names()])) {
      await this.publishDevices();
      if (gen !== this.gen) return;
    }
    await this.updateStatus(gen);
  }

  /** The pause left for a service, in ms (0 when none). */
  pausedFor(service, mono = this.monotonic()) {
    const until = this.pauseUntilMono[service];
    return until === null ? 0 : Math.max(0, until - mono);
  }

  isRefused(service) {
    const print = this.persisted.refused[service];
    return !!print && print === this.keyPrint(this.config?.keys[service]);
  }

  /** Why a keyed service cannot be asked now (before its budget), or null. */
  keyGuard(service) {
    if (!this.config.keys[service]) return 'no_key';
    if (this.isRefused(service) && this.probing !== service) return 'key_refused';
    if (this.pausedFor(service) > 0) return 'paused';
    return null;
  }

  /** Today's count of a key, reset on a new Chicago day or another key. */
  quotaFor(service, wall = this.now()) {
    const day = chicagoDay(wall);
    const print = this.keyPrint(this.config.keys[service]);
    let q = this.persisted.quota[service];
    // A date before today starts a new day; a later one (the clock went back)
    // keeps counting on it, the safe side.
    if (!q || q.key !== print || q.day < day) {
      q = { day, count: 0, key: print };
      this.persisted.quota[service] = q;
    }
    return q;
  }

  /**
   * A request with a key: refused when its budget of the day is spent; else
   * counted, and the count saved to /data, before it leaves.
   */
  async keyedCall(service, url, gen) {
    const q = this.quotaFor(service);
    if (q.count >= this.config.dailyBudget) return { ok: false, kind: 'budget' };
    q.count += 1;
    await this.persist();
    if (gen !== this.gen) return null;
    this.lastServiceMono[service] = this.monotonic();
    return this.call(url, gen, service);
  }

  /**
   * One request, when its turn comes: after the one in flight, 1 s after the
   * start of the previous one. `null` when stopped meanwhile. A 429, a 5xx
   * or another unexpected status pauses the service, even when the
   * configuration changed while the request was out.
   */
  async call(url, gen, service) {
    for (;;) {
      if (gen !== this.gen) return null;
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      const wait = this.lastRequestMono + REQUEST_GAP - this.monotonic();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      break;
    }
    // A pause started meanwhile (a late answer of an older round) holds this one.
    if (this.pausedFor(service) > 0) return { ok: false, kind: 'paused' };
    this.lastRequestMono = this.monotonic();
    const job = getJson(url, { fetchImpl: this.fetchImpl, timers: this.timers });
    this.inflight = job.then(
      () => {},
      () => {},
    );
    let result;
    try {
      result = await job;
    } finally {
      this.inflight = null;
    }
    if (!result.ok && ['rate', 'server', 'http'].includes(result.kind)) {
      this.startPause(service, result);
      if (gen !== this.gen) await this.persist();
    }
    return result;
  }

  /** Whether the `Date` of an answer is believable: `{ at }` or `{ kind }`. */
  freshness(answer) {
    const at = answer.serverDate;
    if (at === null || at === undefined) return { kind: 'no_date' };
    const skew = at - this.now();
    if (Math.abs(skew) > CLOCK_SKEW) {
      this.logger.warn('The Date of the CTA answer differs from the local clock: not used');
      return { kind: 'clock', detail: Math.round(skew / MINUTE) };
    }
    return { at };
  }

  /** The source answered a keyed service: its pause and its refusal end. */
  answered(service) {
    this.accepted[service] = this.config.keys[service];
    this.pauseUntilMono[service] = null;
    delete this.persisted.pause[service];
    if (this.persisted.refused[service]) {
      this.persisted.refused[service] = null;
      this.logger.info(`The ${service} key was accepted again`);
    }
  }

  /** An error the CTA gave in its answer (200 with an error code). */
  apiFailure(service, read) {
    if (read.kind === 'key_refused') {
      this.persisted.refused[service] = this.keyPrint(this.config.keys[service]);
      this.logger.warn(`The CTA refused the ${service} key: not sent again until it changes`);
    } else if (read.kind === 'quota') {
      this.startPause(service, { kind: 'quota' });
      this.logger.warn(`The CTA says the daily limit of the ${service} key is reached`);
    } else if (read.kind === 'server' || read.kind === 'api_error') {
      this.startPause(service, { kind: read.kind });
    }
  }

  /** Whether the watch's id was found unknown less than 30 min ago. */
  isMissing(watch, mono) {
    const entry = this.missing.get(watchKey(watch));
    return !!entry && mono - entry.mono < MISSING_RETRY - ALERTS_SLACK;
  }

  setMissing(watch) {
    this.missing.set(watchKey(watch), {
      fingerprint: this.fingerprint(watch),
      mono: this.monotonic(),
    });
    this.logger.warn(`Watch ${watchKey(watch)}: the CTA does not know its id`);
  }

  learn(watch, info) {
    const key = watchKey(watch);
    const fingerprint = this.fingerprint(watch);
    const before = this.learnt.get(key);
    const entry =
      before && before.fingerprint === fingerprint
        ? before
        : { fingerprint, name: null, station: null, routes: [] };
    if (info.name) entry.name = info.name;
    if (info.station) entry.station = info.station;
    for (const route of info.routes ?? []) {
      if (!entry.routes.includes(route) && entry.routes.length < 10) entry.routes.push(route);
    }
    this.learnt.set(key, entry);
  }

  confirm(watch) {
    this.persisted.confirmed[watchKey(watch)] = this.fingerprint(watch);
  }

  isConfirmed(watch) {
    return this.persisted.confirmed[watchKey(watch)] === this.fingerprint(watch);
  }

  /** The Train Tracker arrivals of each train watch: one request each. */
  async readTrains(gen, watches = this.config.watches.filter((w) => w.kind === 'train')) {
    for (const watch of watches) {
      if (gen !== this.gen) return;
      const guard = this.keyGuard('train');
      if (guard) {
        this.recordFailure(watch, 'dep', { kind: guard });
        continue;
      }
      if (this.isMissing(watch, this.monotonic())) {
        this.recordFailure(watch, 'dep', { kind: 'stop_missing' });
        continue;
      }
      const url = trainUrl(this.config.keys.train, watch.id, this.urls.train);
      const answer = await this.keyedCall('train', url, gen);
      if (answer === null || gen !== this.gen) return;
      if (!answer.ok) {
        this.logger.warn(`Watch ${watchKey(watch)}: trains not read (${answer.kind})`);
        this.recordFailure(watch, 'dep', answer);
        continue;
      }
      const fresh = this.freshness(answer);
      if (fresh.kind) {
        this.recordFailure(watch, 'dep', fresh);
        continue;
      }
      const read = readTrain(answer.json);
      if (!read.ok) {
        this.logger.warn(`Watch ${watchKey(watch)}: trains not published (${read.kind})`);
        this.apiFailure('train', read);
        if (read.kind === 'stop_missing') this.setMissing(watch);
        this.recordFailure(watch, 'dep', read);
        continue;
      }
      this.answered('train');
      // The time stamp of the answer must agree with its Date (both are the server's).
      if (Math.abs(read.at - fresh.at) > STAMP_SKEW) {
        this.recordFailure(watch, 'dep', { kind: 'stale' });
        continue;
      }
      const result = trainDepartures(watch, read);
      if (!result.ok) {
        this.recordFailure(watch, 'dep', result);
        continue;
      }
      // Error code 0 for this id: the CTA knows the station or stop.
      this.confirm(watch);
      this.learn(watch, { name: result.name, station: result.station });
      await this.onDepartures(watch, result.departures, read.at, gen);
    }
  }

  /** The Bus Tracker predictions of every bus watch: one request. */
  async readBuses(gen) {
    const all = this.config.watches.filter((w) => w.kind === 'bus');
    if (all.length === 0) return;
    const guard = this.keyGuard('bus');
    if (guard) {
      for (const watch of all) this.recordFailure(watch, 'dep', { kind: guard });
      return;
    }
    const mono = this.monotonic();
    const watches = [];
    for (const watch of all) {
      if (this.isMissing(watch, mono)) this.recordFailure(watch, 'dep', { kind: 'stop_missing' });
      else watches.push(watch);
    }
    if (watches.length === 0) return;
    const stops = [...new Set(watches.map((w) => w.id))];
    const answer = await this.keyedCall(
      'bus',
      busUrl(this.config.keys.bus, stops, this.urls.bus),
      gen,
    );
    if (answer === null || gen !== this.gen) return;
    if (!answer.ok) {
      this.logger.warn(`Buses not read (${answer.kind})`);
      for (const watch of watches) this.recordFailure(watch, 'dep', answer);
      return;
    }
    const fresh = this.freshness(answer);
    if (fresh.kind) {
      for (const watch of watches) this.recordFailure(watch, 'dep', fresh);
      return;
    }
    const read = readBus(answer.json);
    if (!read.ok) {
      this.logger.warn(`Buses not published (${read.kind})`);
      this.apiFailure('bus', read);
      for (const watch of watches) this.recordFailure(watch, 'dep', read);
      return;
    }
    this.answered('bus');
    for (const watch of watches) {
      if (gen !== this.gen) return;
      const result = busDepartures(watch, read, fresh.at);
      if (!result.ok) {
        if (result.kind === 'stop_missing') this.setMissing(watch);
        this.recordFailure(watch, 'dep', result);
        continue;
      }
      if (result.seen) this.confirm(watch);
      this.learn(watch, { name: result.name, routes: result.routes });
      // "No departure" is only told for a stop id a bus has confirmed: a
      // mistyped id would read as an empty stop.
      if (result.departures.length === 0 && !this.isConfirmed(watch)) {
        this.recordFailure(watch, 'dep', { kind: 'stop_unchecked' });
        continue;
      }
      await this.onDepartures(watch, result.departures, fresh.at, gen);
    }
  }

  async onDepartures(watch, departures, at, gen) {
    const count = countWithin(departures);
    const language = this.config.language;
    this.setResult(watch, 'dep', {
      ok: true,
      readAt: at,
      readMono: this.monotonic(),
      count,
      next: departures[0] ?? null,
    });
    const ids = watchIds(this.gladys, watch);
    if (!this.isCreated(ids) || gen !== this.gen) return;
    // Every value at every read: a departure gone is replaced by its text
    // "no departure", never left behind.
    const states = [
      {
        device_feature_external_id: ids.feature(FEATURES.NEXT),
        text: departureText(departures[0], at, language, 'next'),
      },
      {
        device_feature_external_id: ids.feature(FEATURES.SECOND),
        text: departureText(departures[1], at, language, 'second'),
      },
      { device_feature_external_id: ids.feature(FEATURES.DEPARTURES), state: count },
      {
        device_feature_external_id: ids.feature(FEATURES.SUMMARY),
        text: summary(departures, at, language),
      },
    ];
    try {
      await this.bounded(() => this.gladys.publishStates(states));
    } catch (err) {
      this.logger.warn(
        `Watch ${watchKey(watch)}: departures not published (${err?.name ?? 'Error'})`,
      );
    }
  }

  isCreated(ids) {
    return !!this.gladys.devices?.some((device) => device.external_id === ids.device);
  }

  /**
   * What the alerts of a watch are asked for: its station (named by Train
   * Tracker) or the bus routes seen at its stop; null until a read told them.
   */
  alertTarget(watch) {
    const info = this.learnt.get(watchKey(watch));
    if (!info || info.fingerprint !== this.fingerprint(watch)) return null;
    if (watch.kind === 'train') return info.station ? { station: info.station } : null;
    return info.routes.length > 0 ? { routes: info.routes } : null;
  }

  /**
   * The alerts of each watch that is due (every 5 min; a round within 5 s of
   * it counts), one request each, no key; secondary, spaced out on failure.
   * A watch skipped (pause, nothing learnt yet) stays due.
   */
  async readAllAlerts(gen, start) {
    for (const watch of this.config.watches) {
      if (gen !== this.gen) return;
      const key = watchKey(watch);
      const due = this.alertsDue.get(key);
      if (due && start < due.dueMono - ALERTS_SLACK) continue;
      const target = this.alertTarget(watch);
      if (!target) {
        this.recordFailure(watch, 'alerts', { kind: 'waiting' });
        continue;
      }
      if (this.pausedFor('alerts') > 0) {
        this.recordFailure(watch, 'alerts', { kind: 'paused' });
        continue;
      }
      const answer = await this.call(alertsUrl(target, this.urls.alerts), gen, 'alerts');
      if (answer === null || gen !== this.gen) return;
      if (!answer.ok) {
        if (answer.kind !== 'paused') this.alertsFailed(key, start);
        this.logger.warn(`Watch ${key}: alerts not read (${answer.kind})`);
        this.recordFailure(watch, 'alerts', answer);
        continue;
      }
      const fresh = this.freshness(answer);
      const read = fresh.kind ? null : readAlerts(answer.json);
      let kind = fresh.kind ?? (read.ok ? null : read.kind);
      if (!kind && Math.abs(read.at - fresh.at) > STAMP_SKEW) kind = 'stale';
      if (kind) {
        this.alertsFailed(key, start);
        this.logger.warn(`Watch ${key}: alerts not published (${kind})`);
        this.recordFailure(watch, 'alerts', { kind, detail: fresh.detail });
        continue;
      }
      this.pauseUntilMono.alerts = null;
      delete this.persisted.pause.alerts;
      this.alertsDue.set(key, { dueMono: start + ALERTS_INTERVAL, level: 0 });
      await this.onAlerts(watch, read.alerts, fresh.at, gen);
    }
  }

  /** A failed alerts read: the next one 5 min later, then doubled, bounded to 1 h. */
  alertsFailed(key, start) {
    const level = Math.min((this.alertsDue.get(key)?.level ?? 0) + 1, 10);
    const delay = Math.min(ALERTS_INTERVAL * 2 ** (level - 1), ALERTS_RETRY_MAX);
    this.alertsDue.set(key, { dueMono: start + delay, level });
  }

  async onAlerts(watch, alerts, at, gen) {
    this.setResult(watch, 'alerts', {
      ok: true,
      readAt: at,
      readMono: this.monotonic(),
      count: alerts.length,
    });
    const ids = watchIds(this.gladys, watch);
    if (this.isCreated(ids)) {
      try {
        await this.bounded(() =>
          this.gladys.publishStates([
            { device_feature_external_id: ids.feature(FEATURES.ALERTS), state: alerts.length },
            {
              device_feature_external_id: ids.feature(FEATURES.ALERT_TEXT),
              text: alertText(alerts, this.config.language),
            },
          ]),
        );
      } catch (err) {
        this.logger.warn(
          `Watch ${watchKey(watch)}: alerts not published (${err?.name ?? 'Error'})`,
        );
      }
    }
    if (gen !== this.gen) return;
    await this.announceNew(watch, alerts, at, gen);
  }

  /**
   * The scene trigger: an alert seen for the first time at this watch whose
   * start is known and within the 24 h before the read. The first read of a
   * watch (or of a changed one, or after an unreadable /data) only learns
   * what is there.
   */
  async announceNew(watch, alerts, at, gen) {
    const key = watchKey(watch);
    const fingerprint = this.fingerprint(watch);
    const wall = this.now();
    const previous = this.persisted.watches[key];
    const baseline = !previous || previous.fingerprint !== fingerprint;
    const seen = baseline ? {} : previous.seen;
    const fresh = [];
    if (!baseline) {
      for (const alert of sortAlerts(alerts)) {
        if (seen[alert.id] !== undefined) continue;
        if (alert.start === null || alert.start > at + 5 * MINUTE) continue;
        if (at - alert.start <= FRESH_ALERT) fresh.push(alert);
      }
    }
    for (const alert of alerts) seen[alert.id] = wall;
    // Bounded: entries not seen for 7 days go, then the oldest past SEEN_MAX.
    const kept = Object.entries(seen)
      .filter(([, when]) => wall - when <= SEEN_KEEP)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEEN_MAX);
    this.persisted.watches[key] = { fingerprint, seen: Object.fromEntries(kept) };
    const device = watchIds(this.gladys, watch).device;
    for (const alert of fresh.slice(0, SCENE_EVENTS_PER_READ)) {
      if (gen !== this.gen) return;
      try {
        await this.bounded(() =>
          this.gladys.publishSceneEvent(SCENE_TRIGGER, sceneData(device, alert)),
        );
      } catch (err) {
        this.logger.warn(`Watch ${key}: scene event not sent (${err?.name ?? 'Error'})`);
      }
    }
  }

  setResult(watch, part, value) {
    const key = watchKey(watch);
    const fingerprint = this.fingerprint(watch);
    const before = this.results.get(key);
    const entry =
      before && before.fingerprint === fingerprint
        ? before
        : { fingerprint, dep: null, alerts: null };
    entry[part] = value;
    this.results.set(key, entry);
  }

  recordFailure(watch, part, result) {
    const before = this.results.get(watchKey(watch));
    const kept = before && before.fingerprint === this.fingerprint(watch) ? before[part] : null;
    this.setResult(watch, part, {
      ok: false,
      failure: { kind: result.kind, status: result.status, detail: result.detail },
      // The last success, for the status: data from then.
      lastOkAt: kept?.ok ? kept.readAt : (kept?.lastOkAt ?? null),
      lastOkMono: kept?.ok ? kept.readMono : (kept?.lastOkMono ?? null),
    });
  }

  startPause(service, result) {
    const pause = this.persisted.pause[service] ?? {
      until: null,
      kind: null,
      status: null,
      level429: 0,
      level5xx: 0,
    };
    const wall = this.now();
    let duration;
    if (result.kind === 'quota') {
      // The day of the key ends at the next Chicago midnight (an hour at least).
      duration = Math.max(nextChicagoMidnight(wall) + QUOTA_RESET_MARGIN - wall, QUOTA_PAUSE_MIN);
    } else {
      if (result.kind === 'rate') {
        pause.level429 = Math.min(pause.level429 + 1, 30);
        duration = PAUSE_429_FIRST * 2 ** (pause.level429 - 1);
      } else {
        pause.level5xx = Math.min(pause.level5xx + 1, 30);
        duration = PAUSE_5XX_FIRST * 2 ** (pause.level5xx - 1);
      }
      if (Number.isFinite(result.retryAfter) && result.retryAfter > duration) {
        duration = result.retryAfter;
      }
      duration = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, duration));
    }
    pause.kind = result.kind;
    pause.status = Number.isInteger(result.status) ? result.status : null;
    const mono = this.monotonic();
    // A shorter pause never replaces a longer one.
    this.pauseUntilMono[service] = Math.max(this.pauseUntilMono[service] ?? 0, mono + duration);
    pause.until = wall + (this.pauseUntilMono[service] - mono);
    this.persisted.pause[service] = pause;
  }

  // --- Status ----------------------------------------------------------------

  /** Departures older than this are said stale: 3 intervals, 5 minutes at least. */
  staleAfter() {
    return Math.max(3 * this.interval, 5 * MINUTE);
  }

  composeStatus() {
    const config = this.config;
    if (!config) return { connected: false, message: M.starting };
    const lines = { en: [], fr: [] };
    const push = (en, fr) => {
      lines.en.push(en);
      lines.fr.push(fr);
    };
    const mono = this.monotonic();
    const wall = this.now();
    const toWall = (m) => wall + (m - mono);
    const staleAfter = this.staleAfter();
    const alertsStale = ALERTS_RETRY_MAX + 10 * MINUTE;
    let anyOk = false;
    for (const service of SERVICES) {
      const paused = this.pausedFor(service, mono);
      if (paused <= 0) continue;
      const kind = this.persisted.pause[service]?.kind ?? 'rate';
      const status = this.persisted.pause[service]?.status ?? null;
      const who =
        service === 'alerts'
          ? { en: 'Alerts', fr: 'Alertes' }
          : { en: serviceName(service, 'en'), fr: serviceName(service, 'fr') };
      push(
        `${who.en}: ${failure(kind, status, 'en')}; paused until ${formatTime(wall + paused, 'en')}.`,
        `${who.fr} : ${failure(kind, status, 'fr')} ; en pause jusqu'à ${formatTime(wall + paused, 'fr')}.`,
      );
    }
    for (const service of KEYED) {
      if (!config.watches.some((w) => w.kind === service)) continue;
      const name = { en: serviceName(service, 'en'), fr: serviceName(service, 'fr') };
      if (!config.keys[service]) {
        push(
          `${name.en}: ${failure('no_key', null, 'en')}.`,
          `${name.fr} : ${failure('no_key', null, 'fr')}.`,
        );
        continue;
      }
      if (this.isRefused(service)) {
        push(
          `${name.en}: ${failure('key_refused', null, 'en')}.`,
          `${name.fr} : ${failure('key_refused', null, 'fr')}.`,
        );
      }
      const q = this.persisted.quota[service];
      const used =
        q && q.day === chicagoDay(wall) && q.key === this.keyPrint(config.keys[service])
          ? q.count
          : 0;
      push(
        `${name.en}: ${used} of ${config.dailyBudget} requests today (Chicago date).`,
        `${name.fr} : ${used} requêtes sur ${config.dailyBudget} aujourd'hui (date de Chicago).`,
      );
    }
    const why = (f) => {
      const text = { en: failure(f.kind, f.status, 'en'), fr: failure(f.kind, f.status, 'fr') };
      if (f.kind === 'clock' && Number.isFinite(f.detail)) {
        text.en += ` (${f.detail > 0 ? '+' : ''}${f.detail} min)`;
        text.fr += ` (${f.detail > 0 ? '+' : ''}${f.detail} min)`;
      }
      return text;
    };
    const since = (r, limit) =>
      r.lastOkAt !== null
        ? {
            en: `; last data ${formatTime(r.lastOkAt, 'en')}${mono - r.lastOkMono > limit ? ', stale' : ''}, nothing published since`,
            fr: ` ; dernières données ${formatTime(r.lastOkAt, 'fr')}${mono - r.lastOkMono > limit ? ', périmées' : ''}, rien publié depuis`,
          }
        : { en: '; no data yet', fr: ' ; pas encore de données' };
    const names = this.names();
    for (const watch of config.watches) {
      const key = watchKey(watch);
      const name = {
        en: watchLabel(watch, 'en', names.get(key)),
        fr: watchLabel(watch, 'fr', names.get(key)),
      };
      const result = this.results.get(key);
      const dep = result?.dep ?? null;
      const alerts = result?.alerts ?? null;
      let depText;
      if (!dep) depText = { en: 'departures not read yet', fr: 'départs pas encore lus' };
      else if (dep.ok) {
        const stale = mono - dep.readMono > staleAfter;
        if (!stale) anyOk = true;
        const next = dep.next
          ? {
              en: `next in ${dep.next.minutes} min (${dep.next.label})`,
              fr: `prochain dans ${dep.next.minutes} min (${dep.next.label})`,
            }
          : { en: 'no predicted departure', fr: 'aucun départ prévu' };
        depText = {
          en: `${next.en}, ${dep.count} departure(s) within 30 min, read ${formatTime(dep.readAt, 'en')}${stale ? ' (stale)' : ''}`,
          fr: `${next.fr}, ${dep.count} départ(s) dans les 30 min, lu ${formatTime(dep.readAt, 'fr')}${stale ? ' (périmé)' : ''}`,
        };
      } else {
        const w = why(dep.failure);
        const s = since(dep, staleAfter);
        depText = { en: `departures: ${w.en}${s.en}`, fr: `départs : ${w.fr}${s.fr}` };
      }
      let alertsText;
      if (!alerts) alertsText = { en: 'alerts not read yet', fr: 'alertes pas encore lues' };
      else if (alerts.ok) {
        const stale = mono - alerts.readMono > alertsStale;
        alertsText = {
          en: `${alerts.count} alert(s), read ${formatTime(alerts.readAt, 'en')}${stale ? ' (stale)' : ''}`,
          fr: `${alerts.count} alerte(s), lu ${formatTime(alerts.readAt, 'fr')}${stale ? ' (périmé)' : ''}`,
        };
      } else {
        const w = why(alerts.failure);
        const s = since(alerts, alertsStale);
        alertsText = { en: `alerts: ${w.en}${s.en}`, fr: `alertes : ${w.fr}${s.fr}` };
      }
      push(
        `${name.en}: ${depText.en}; ${alertsText.en}.`,
        `${name.fr} : ${depText.fr} ; ${alertsText.fr}.`,
      );
    }
    // Devices of ids no longer watched: never updated again.
    const current = new Set(config.watches.map((w) => watchIds(this.gladys, w).device));
    const old = (this.gladys.devices ?? []).filter(
      (d) => isWatchDevice(this.gladys, d?.external_id) && !current.has(d.external_id),
    );
    if (old.length > 0) {
      const list = old.map((d) => d.name).join(', ');
      push(
        `Not updated any more (no longer in the configuration), delete in Gladys: ${list}.`,
        `Plus mis à jour (retiré de la configuration), à supprimer dans Gladys : ${list}.`,
      );
    }
    if (this.interval > config.refreshSeconds * SECOND) {
      const seconds = Math.round(this.interval / SECOND);
      push(
        `Reads every ${seconds} s (not ${config.refreshSeconds} s) to fit the daily budget of the keys.`,
        `Lectures toutes les ${seconds} s (pas ${config.refreshSeconds} s) pour tenir le budget quotidien des clés.`,
      );
    }
    if (this.nextDueMono !== null) {
      push(
        `Next read ${formatTime(toWall(this.nextDueMono), 'en')}.`,
        `Prochaine lecture ${formatTime(toWall(this.nextDueMono), 'fr')}.`,
      );
    }
    if (config.errors.length > 0) {
      const errors = configErrors(config.errors);
      push(`Configuration: ${errors.en}.`, `Configuration : ${errors.fr}.`);
    }
    if (this.dataTells === false && this.lastAttemptMono === null) {
      push(
        '/data does not tell when the CTA was last read: the first read waits 30 s after the start.',
        '/data ne dit pas quand la CTA a été lue : la première lecture attend 30 s après le démarrage.',
      );
    }
    if (this.saveFailed) {
      push(
        'The state could not be written in /data: a restart may read sooner than the interval and count the requests of the day from 0.',
        "L'état n'a pas pu être écrit dans /data : un redémarrage peut lire plus tôt que l'intervalle et recompter les requêtes du jour depuis 0.",
      );
    }
    if (this.storeStatus === 'unreadable') {
      push(
        'The state file of /data is unreadable: left untouched, the integration runs from memory (requests of the day counted from 0).',
        "Le fichier d'état de /data est illisible : laissé tel quel, l'intégration tourne en mémoire (requêtes du jour comptées depuis 0).",
      );
    }
    const message = {};
    for (const lang of LANGS)
      message[lang] = [...lines[lang].join(' ')].slice(0, STATUS_MAX).join('');
    return { connected: anyOk, message };
  }

  async updateStatus(gen) {
    const { connected, message } = this.composeStatus();
    await this.setStatus(connected, message, gen);
  }

  async setStatus(connected, message, gen) {
    if (gen !== this.gen) return;
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    try {
      await this.bounded(() => this.gladys.setConnectionStatus(connected, message));
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Status not published (${err?.name ?? 'Error'})`);
    }
  }
}

/** The flat data of the scene trigger (≤ 30 keys, texts bounded). */
export function sceneData(device, alert) {
  const text = (value) => [...String(value ?? '')].slice(0, SCENE_TEXT_MAX).join('');
  return {
    device,
    alert_id: text(alert.id),
    major: alert.major ? 'yes' : 'no',
    severity: alert.severity,
    headline: text(alert.headline),
    description: text(alert.description),
    impact: text(alert.impact),
    url: text(alert.url),
  };
}
