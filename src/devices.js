// -----------------------------------------------------------------------------
// One Gladys device per watched station or stop, read-only. Its id is its
// kind, its slot in the configuration and the CTA id (`train:1-40380`,
// `bus:2-456`): another id in a slot is another device, never an old device
// (with the values of the old stop) under a new stop. The route filter can
// change without a new device: every read publishes every value again.
//
// Features: the next and the following departure (texts: a departure that
// no longer exists is replaced by "no departure", never left as a number),
// the predicted departures within 30 minutes and the alerts in effect
// (counters, for the scenes), the summary and the first alert (texts).
// No `poll_frequency`: the app reads the CTA at its own pace.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { COUNT_MAX, FEATURES, KINDS } from './constants.js';
import { t, watchLabel } from './i18n.js';

/** The ids of a watch: kind, slot and CTA id (`ext:cta:train:1-40380`). */
export const watchIds = (gladys, watch) =>
  gladys.externalIds(watch.kind, `${watch.slot}-${watch.id}`);

/** Whether an external id belongs to a watch device of the integration. */
export const isWatchDevice = (gladys, externalId) =>
  typeof externalId === 'string' &&
  KINDS.some((kind) => externalId.startsWith(gladys.externalId(`${kind}:`)));

export function buildDevice(gladys, watch, language, name = null) {
  const ids = watchIds(gladys, watch);
  const counter = (key, label, history) => ({
    name: label,
    external_id: ids.feature(key),
    category: C.COUNTER_SENSOR,
    type: T.SENSOR.INTEGER,
    min: 0,
    max: COUNT_MAX,
    read_only: true,
    has_feedback: false,
    keep_history: history,
  });
  const text = (key, label) => ({
    name: label,
    external_id: ids.feature(key),
    category: C.TEXT,
    type: T.TEXT.TEXT,
    // The core columns are NOT NULL; a text has no range (0/0 as the core UI).
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  });
  return {
    name: watchLabel(watch, language, name),
    external_id: ids.device,
    params: [
      { name: 'kind', value: watch.kind },
      { name: 'id', value: watch.id },
    ],
    features: [
      text(FEATURES.NEXT, t(language, 'nextFeature')),
      text(FEATURES.SECOND, t(language, 'secondFeature')),
      counter(FEATURES.DEPARTURES, t(language, 'departuresFeature'), false),
      text(FEATURES.SUMMARY, t(language, 'summaryFeature')),
      counter(FEATURES.ALERTS, t(language, 'alertsFeature'), true),
      text(FEATURES.ALERT_TEXT, t(language, 'alertTextFeature')),
    ],
  };
}

/** `names`: the CTA name of each watch (by `train1`, `bus2`), when known. */
export function buildDevices(gladys, config, names = new Map()) {
  return config.watches.map((watch) =>
    buildDevice(gladys, watch, config.language, names.get(`${watch.kind}${watch.slot}`) ?? null),
  );
}
