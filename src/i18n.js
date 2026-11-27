// -----------------------------------------------------------------------------
// Every text the integration writes, in English and French: the device names
// and summaries (in the language of the configuration), the status and the
// test button (both languages, Gladys picks). Times are shown in Chicago
// time; CTA texts (station names, destinations, alerts) stay in English, the
// only language of the APIs.
// -----------------------------------------------------------------------------

import { TIME_ZONE, TRAIN_ROUTES } from './constants.js';

const TEXTS = {
  en: {
    noDeparture: 'No predicted departure',
    nextIn: ({ label, minutes }) => `next: ${label} in ${minutes} min`,
    noAlert: 'No alert',
    noNext: ({ clock }) => `No predicted departure (read ${clock})`,
    noSecond: ({ clock }) => `No following departure (read ${clock})`,
    departsIn: ({ label, minutes, clock }) => `${label} in ${minutes} min (${clock})`,
    due: ({ label, clock }) => `${label} due (${clock})`,
    delayed: 'delayed',
    scheduled: 'scheduled time',
    moreAlerts: ({ count }) => (count === 1 ? '1 more alert' : `${count} more alerts`),
    trainDefault: ({ id }) => `Chicago 'L' station ${id}`,
    trainNamed: ({ name }) => `${name} ('L' trains)`,
    busDefault: ({ id }) => `Chicago bus stop ${id}`,
    busNamed: ({ name }) => `${name} (buses)`,
    nextFeature: 'Next departure',
    secondFeature: 'Following departure',
    departuresFeature: 'Predicted departures (30 min)',
    summaryFeature: 'Departures',
    alertsFeature: 'Alerts in effect',
    alertTextFeature: 'Alert',
  },
  fr: {
    noDeparture: 'Aucun départ prévu',
    nextIn: ({ label, minutes }) => `prochain : ${label} dans ${minutes} min`,
    noAlert: 'Aucune alerte',
    noNext: ({ clock }) => `Aucun départ prévu (lu à ${clock})`,
    noSecond: ({ clock }) => `Aucun départ suivant (lu à ${clock})`,
    departsIn: ({ label, minutes, clock }) => `${label} dans ${minutes} min (${clock})`,
    due: ({ label, clock }) => `${label} à l'approche (${clock})`,
    delayed: 'en retard',
    scheduled: 'horaire théorique',
    moreAlerts: ({ count }) => (count === 1 ? '1 autre alerte' : `${count} autres alertes`),
    trainDefault: ({ id }) => `Station du 'L' de Chicago ${id}`,
    trainNamed: ({ name }) => `${name} (trains du 'L')`,
    busDefault: ({ id }) => `Arrêt de bus de Chicago ${id}`,
    busNamed: ({ name }) => `${name} (bus)`,
    nextFeature: 'Prochain départ',
    secondFeature: 'Départ suivant',
    departuresFeature: 'Départs prévus (30 min)',
    summaryFeature: 'Départs',
    alertsFeature: 'Alertes en cours',
    alertTextFeature: 'Alerte',
  },
};

export function t(language, key, params = {}) {
  const text = (TEXTS[language] ?? TEXTS.en)[key];
  return typeof text === 'function' ? text(params) : text;
}

function parts(ms) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
}

/** The hour and minute in Chicago time, `"02:05"` (summaries). */
export function formatClock(ms) {
  if (!Number.isFinite(ms)) return '?';
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
}

const MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  fr: [
    'janv.',
    'févr.',
    'mars',
    'avr.',
    'mai',
    'juin',
    'juil.',
    'août',
    'sept.',
    'oct.',
    'nov.',
    'déc.',
  ],
};

/** A time in Chicago time: "Nov 27, 14:05 CT" / "27 nov., 14 h 05 (heure de Chicago)". */
export function formatTime(ms, language) {
  if (!Number.isFinite(ms)) return '?';
  const p = parts(ms);
  const month = Number(p.month);
  if (language === 'fr') {
    return `${Number(p.day)} ${MONTHS.fr[month - 1]}, ${p.hour} h ${p.minute} (heure de Chicago)`;
  }
  return `${MONTHS.en[month - 1]} ${Number(p.day)}, ${p.hour}:${p.minute} CT`;
}

/** The name of a train route ("Red Line"), or its id. */
export const trainRouteName = (id) => TRAIN_ROUTES[id]?.name ?? id;

const ERRORS = {
  station_invalid: {
    en: "is not an 'L' station (40000-49999) or platform stop (30000-39999) id",
    fr: "n'est pas un identifiant de station (40000-49999) ou de quai (30000-39999) du 'L'",
  },
  stop_invalid: {
    en: 'is not a bus stop id (digits only, e.g. 456)',
    fr: "n'est pas un identifiant d'arrêt de bus (chiffres seulement, ex. 456)",
  },
  routes_invalid: {
    en: 'holds an invalid route (letters and digits only, comma separated, e.g. 20, X9)',
    fr: 'contient une ligne invalide (lettres et chiffres seulement, séparées par des virgules, ex. 20, X9)',
  },
  train_route_invalid: {
    en: 'holds an unknown line (Red, Blue, Brown, Green, Orange, Purple, Pink, Yellow)',
    fr: 'contient une ligne inconnue (Red, Blue, Brown, Green, Orange, Purple, Pink, Yellow)',
  },
  routes_too_many: { en: 'names more than 8 routes', fr: 'nomme plus de 8 lignes' },
  name_invalid: {
    en: 'is invalid (60 characters at most, no control character)',
    fr: 'est invalide (60 caractères au plus, sans caractère de contrôle)',
  },
  refresh: {
    en: 'must be a whole number of seconds between 30 and 600 (60 used)',
    fr: 'doit être un nombre entier de secondes entre 30 et 600 (60 utilisé)',
  },
  budget: {
    en: 'must be a whole number between 500 and 100000 (10000 used)',
    fr: 'doit être un nombre entier entre 500 et 100000 (10000 utilisé)',
  },
  key_invalid: {
    en: 'is not a key of the CTA (letters and digits only): not used',
    fr: "n'est pas une clé de la CTA (lettres et chiffres seulement) : non utilisée",
  },
};

/** "Field train1_station is ..." in both languages. */
export function configErrors(errors) {
  const line = (lang) =>
    errors
      .map(
        (e) =>
          `${lang === 'fr' ? 'Le champ' : 'Field'} ${e.field} ${ERRORS[e.code]?.[lang] ?? e.code}`,
      )
      .join('; ');
  return { en: line('en'), fr: line('fr') };
}

const FAILURES = {
  network: { en: 'the CTA could not be reached', fr: 'CTA injoignable' },
  timeout: { en: 'the CTA did not answer in time', fr: "la CTA n'a pas répondu à temps" },
  rate: { en: 'the CTA asked to slow down (429)', fr: 'la CTA demande de ralentir (429)' },
  server: { en: 'CTA server error', fr: 'erreur du serveur de la CTA' },
  http: { en: 'unexpected answer from the CTA', fr: 'réponse inattendue de la CTA' },
  api_error: { en: 'the CTA refused the request', fr: 'la CTA a refusé la requête' },
  disabled: {
    en: 'the CTA says its developer API is disabled (no access permitted)',
    fr: 'la CTA dit que son API développeur est désactivée (aucun accès permis)',
  },
  format: { en: 'CTA answer not readable', fr: 'réponse de la CTA illisible' },
  too_big: { en: 'CTA answer too large', fr: 'réponse de la CTA trop grande' },
  unreadable: {
    en: 'the CTA sends items that cannot be read (its format may have changed), nothing published',
    fr: 'la CTA envoie des éléments illisibles (son format a peut-être changé), rien publié',
  },
  no_date: {
    en: 'the CTA answer carries no usable time, nothing published',
    fr: "la réponse de la CTA n'a pas d'heure utilisable, rien publié",
  },
  stale: {
    en: 'the CTA real-time data is not updated (frozen feed), nothing published',
    fr: 'les données temps réel de la CTA ne sont plus mises à jour (flux figé), rien publié',
  },
  clock: {
    en: 'the time of the CTA answer differs from the clock of this machine (set the clock of the machine, or a cache serves an old answer): nothing published',
    fr: "l'heure de la réponse de la CTA diffère de l'horloge de cette machine (réglez l'horloge de la machine, ou un cache sert une vieille réponse) : rien publié",
  },
  stop_missing: {
    en: 'the CTA does not know this id: check it (asked again in 30 min)',
    fr: 'la CTA ne connaît pas cet identifiant : vérifiez-le (redemandé dans 30 min)',
  },
  stop_error: {
    en: 'the CTA gave an error for this stop',
    fr: 'la CTA a renvoyé une erreur pour cet arrêt',
  },
  stop_unchecked: {
    en: 'no prediction, and no bus has confirmed this stop id yet: nothing published',
    fr: "aucune prévision, et aucun bus n'a encore confirmé cet identifiant d'arrêt : rien publié",
  },
  no_key: {
    en: 'no API key for this service in the configuration',
    fr: "aucune clé d'API pour ce service dans la configuration",
  },
  key_refused: {
    en: 'the CTA refused the API key: nothing is sent with it until the key changes or the button "Show the last read / retry the key" succeeds',
    fr: "la CTA a refusé la clé d'API : plus rien n'est envoyé avec elle tant que la clé ne change pas ou que le bouton « Voir la dernière lecture / réessayer la clé » ne réussit pas",
  },
  quota: {
    en: 'the CTA says the daily limit of the key is reached',
    fr: 'la CTA dit que la limite quotidienne de la clé est atteinte',
  },
  budget: {
    en: 'the daily budget of the key is spent (setting "Daily budget per key")',
    fr: 'le budget quotidien de la clé est épuisé (réglage « Budget quotidien par clé »)',
  },
  waiting: {
    en: 'waiting for a first departures read that names the station or the routes',
    fr: 'en attente d’une première lecture des départs qui nomme la station ou les lignes',
  },
  paused: { en: 'not read (pause)', fr: 'non lu (pause)' },
};

export function failure(kind, status, lang) {
  const text = FAILURES[kind]?.[lang] ?? FAILURES.http[lang];
  const full = status && ['http', 'server'].includes(kind) ? `${text} (HTTP ${status})` : text;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

/** The bilingual messages of the status and the test button. */
export const M = {
  starting: {
    en: 'Starting: the first read of the CTA comes shortly.',
    fr: 'Démarrage : la première lecture de la CTA arrive sous peu.',
  },
  configRetry: ({ seconds }) => ({
    en: `The configuration could not be read from Gladys; next try in ${seconds} s.`,
    fr: `La configuration n'a pas pu être lue dans Gladys ; nouvel essai dans ${seconds} s.`,
  }),
  noWatch: {
    en: 'No valid station or stop: fill in a train station id (e.g. 40380 for Clark/Lake) or a bus stop id.',
    fr: 'Aucune station ni aucun arrêt valide : renseignez un identifiant de station (ex. 40380 pour Clark/Lake) ou d’arrêt de bus.',
  },
  busy: {
    en: 'A read is in progress: press again in a few seconds.',
    fr: 'Une lecture est en cours : appuyez de nouveau dans quelques secondes.',
  },
};

const SERVICE = {
  train: { en: 'Train Tracker key', fr: 'Clé Train Tracker' },
  bus: { en: 'Bus Tracker key', fr: 'Clé Bus Tracker' },
};
export const serviceName = (service, lang) => SERVICE[service][lang];

/** The device name: the name typed, else the CTA name, else its id. */
export function watchLabel(watch, language, name = null) {
  if (watch.name) return watch.name;
  const kind = watch.kind === 'train' ? 'train' : 'bus';
  if (name) return t(language, `${kind}Named`, { name });
  return t(language, `${kind}Default`, { id: watch.id });
}
