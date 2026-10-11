// -----------------------------------------------------------------------------
// Device type: STOP
//
// One device per stop the user watches (typed in the configuration, suggested
// near the house, or created from an earlier suggestion). Read-only, refreshed
// by polling at `departures_poll_frequency` (departures are countdowns: they
// are only useful while fresh). Two sources, same board:
//   - with an operator key, the real-time predictions: every watched stop
//     reads the same network feed, read once per interval (see
//     src/api/realtime.js);
//   - without one, the departures Transitous knows (src/api/transitous.js):
//     the timetable, marked "~" as a scheduled time, and the real time where
//     Transitous has it; never read faster than every two minutes.
//
// Features, for each of the N next departures (N = `max_departures`):
//   - "Departure n"        : minutes to wait     (duration sensor)
//   - "Departure n route"  : "99"                (text sensor)
// plus one "Next departures" text feature summarizing the board
// ("99 3 min · 99 11 min · 14 14 min"), handy for a dashboard tile or a chat
// answer.
//
// None of them keeps an history, and the states that did not move are not even
// published (see stateCache.js): a countdown re-read every minute is the one
// value whose past is worth nothing and whose storage cost is the highest.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  departuresSource,
  gladysPollFrequency,
  MIN_SCHEDULE_POLL_FREQUENCY,
  stopPlatformId,
} from '../config.js';
import { TEXT_FEATURE_RANGE } from './featureRange.js';
import { changedStates } from './stateCache.js';
import { publishDeviceStates } from './publish.js';
import { fetchDepartures, RealtimeApiError } from '../api/realtime.js';
import { knownStop, scheduledDepartures } from '../api/transitous.js';
import { stopByCode } from '../api/stops.js';
import { NETWORK } from '../network.js';

export const DEVICE_TYPE = 'transit-stop';

const logger = createLogger({ name: DEVICE_TYPE });

// The countdown of "no departure": a sentinel rather than an empty value.
export const NO_DEPARTURE_MINUTES = 999;

/** Feature key of the n-th departure countdown (n starts at 1). */
export const departureFeatureKey = (rank) => `departure_${rank}`;
/** Feature key of the n-th departure route. */
export const departureRouteFeatureKey = (rank) => `departure_${rank}_route`;
export const SUMMARY_FEATURE = 'departures';

const LABELS = {
  en: {
    departure: (rank) => (rank === 1 ? 'Next departure' : `Departure ${rank}`),
    route: (rank) => (rank === 1 ? 'Next departure route' : `Departure ${rank} route`),
    summary: 'Next departures',
    none: 'No upcoming departure',
    stop: 'stop',
  },
  fr: {
    departure: (rank) => (rank === 1 ? 'Prochain passage' : `Passage ${rank}`),
    route: (rank) => (rank === 1 ? 'Ligne du prochain passage' : `Ligne du passage ${rank}`),
    summary: 'Prochains passages',
    none: 'Aucun passage à venir',
    stop: 'arrêt',
  },
};

/**
 * One-line board: "99 3 min · 99 11 min · 14 14 min". A scheduled time (no
 * real-time tracking) carries a "~".
 * @param {{ route: string, minutes: number, realtime?: boolean }[]} departures
 * @param {string} language
 */
export function formatSummary(departures, language = 'fr') {
  if (departures.length === 0) {
    return LABELS[language].none;
  }
  return departures
    .map(
      (departure) =>
        `${departure.route} ${departure.realtime === false ? '~' : ''}${departure.minutes} min`,
    )
    .join(' · ');
}

/** What every stop device name starts with, so that a list of devices mixing
 * stops and bike stations reads at a glance. */
export const NAME_PREFIX = NETWORK.stopPrefix;

/**
 * Device name when the user did not give one: the network prefix then the
 * place as people know it — the label of a suggestion, else the stop name of
 * the stop table, else the stop code — plus the route filter. A name the user
 * typed is theirs, and published untouched.
 * @param {{ id: string, routes: string[], name: string | null, label?: string }} stop
 * @param {string} language
 */
export function deviceName(stop, language) {
  if (stop.name) {
    return stop.name;
  }
  if (stop.label) {
    return `${NAME_PREFIX}${stop.label}`;
  }
  const routes = stop.routes.length > 0 ? ` (${stop.routes.join(', ')})` : '';
  const known = stopByCode(stop.id)?.name ?? knownStop(stop.id)?.name;
  return `${NAME_PREFIX}${known || `${LABELS[language].stop} ${stop.id}`}${routes}`;
}

const NO_SOURCE_MESSAGE = {
  en: `No ${NETWORK.realtime?.keyLabel?.en ?? 'API key'}, and the departures without a key are turned off: add a key in the configuration.`,
  fr: `Aucune ${NETWORK.realtime?.keyLabel?.fr ?? 'clé d’API'}, et les passages sans clé sont désactivés : ajoutez une clé dans la configuration.`,
};

const UNKNOWN_STOP_MESSAGE = (code) => ({
  en: `Stop ${code} is not in the ${NETWORK.operator} stop list: check the number on the sign, or update the integration.`,
  fr: `L’arrêt ${code} n’est pas dans la liste des arrêts ${NETWORK.operator} : vérifiez le numéro sur le panneau, ou mettez l’intégration à jour.`,
});

/**
 * Where the departures of one stop come from: the configured source, except
 * that a stop the real-time feed leaves out (the TTC subway) reads the
 * timetable — the feed would only ever say "no departure" there.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ id: string }} stop
 * @returns {'realtime' | 'schedule' | 'none'}
 */
export function stopSource(config, stop) {
  const source = departuresSource(config);
  return source === 'realtime' && stopByCode(stop.id)?.scheduleOnly ? 'schedule' : source;
}

/**
 * The refresh interval of a stop, in seconds: the configured one, but never
 * faster than every two minutes on the timetable (Transitous asks to stay
 * light, and a timetable does not move).
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ id: string }} stop
 */
export function stopPollSeconds(config, stop) {
  return stopSource(config, stop) === 'schedule'
    ? Math.max(config.departures_poll_frequency, MIN_SCHEDULE_POLL_FREQUENCY)
    : config.departures_poll_frequency;
}

/**
 * The blueprint of one watched stop. Built per configured entry (see
 * src/devices/index.js), because how many stops exist is a user decision.
 *
 * @param {{ id: string, routes: string[], name: string | null }} stop
 */
export function createStopBlueprint(stop) {
  // The route filter is part of the platform id: watching the same stop twice
  // with two different filters must yield two distinct devices.
  const platformId = stopPlatformId(stop);

  return {
    key: `${DEVICE_TYPE}:${platformId}`,
    type: DEVICE_TYPE,
    stop,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, platformId).device;
    },

    pollIntervalMs(config) {
      return stopPollSeconds(config, stop) * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, platformId);
      const labels = LABELS[config.language];
      const features = [];

      for (let rank = 1; rank <= config.max_departures; rank += 1) {
        features.push({
          name: labels.departure(rank),
          external_id: ids.feature(departureFeatureKey(rank)),
          category: DEVICE_FEATURE_CATEGORIES.DURATION,
          type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
          unit: DEVICE_FEATURE_UNITS.MINUTES,
          min: 0,
          max: NO_DEPARTURE_MINUTES,
          read_only: true,
          has_feedback: false,
          // A countdown re-read every minute: its history is the shape of
          // every timetable, and would write thousands of rows a day.
          keep_history: false,
        });
        features.push({
          name: labels.route(rank),
          external_id: ids.feature(departureRouteFeatureKey(rank)),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          ...TEXT_FEATURE_RANGE,
          read_only: true,
          has_feedback: false,
          keep_history: false,
        });
      }

      features.push({
        name: labels.summary,
        external_id: ids.feature(SUMMARY_FEATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        ...TEXT_FEATURE_RANGE,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      });

      return {
        name: deviceName(stop, config.language),
        external_id: ids.device,
        // Gladys calls onPoll at this interval, in milliseconds, and only
        // accepts the values its own scheduler knows: the configured refresh
        // interval is honored by pollSchedule.js, not by this field.
        poll_frequency: gladysPollFrequency(stopPollSeconds(config, stop)),
        // `should_poll` is what actually schedules the device: the core only
        // inserts it in its poll scheduler when the flag is set at creation.
        should_poll: true,
        params: [
          { name: 'stop_code', value: stop.id },
          { name: 'routes', value: stop.routes.join(',') },
        ],
        features,
      };
    },

    /**
     * The upcoming departures of the stop, soonest first, route filter
     * applied. Shared by the poll, the dashboard widget and the scene action,
     * so the three always agree on what "the next bus" is.
     */
    read(config) {
      if (!stopByCode(stop.id)) {
        return Promise.reject(
          new RealtimeApiError(`Unknown stop ${stop.id}`, {
            userMessage: UNKNOWN_STOP_MESSAGE(stop.id),
          }),
        );
      }
      switch (stopSource(config, stop)) {
        case 'realtime':
          return fetchDepartures(config, stop);
        case 'schedule':
          return scheduledDepartures(stop);
        default:
          return Promise.reject(
            new RealtimeApiError('No departure source configured', {
              userMessage: NO_SOURCE_MESSAGE,
            }),
          );
      }
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, platformId);
      const departures = await this.read(config);

      logger.info(`Stop ${platformId}: ${departures.length} departure(s) upcoming`);

      const states = [
        {
          device_feature_external_id: ids.feature(SUMMARY_FEATURE),
          text: formatSummary(departures.slice(0, config.max_departures), config.language),
        },
      ];

      for (let rank = 1; rank <= config.max_departures; rank += 1) {
        const departure = departures[rank - 1];
        states.push({
          device_feature_external_id: ids.feature(departureFeatureKey(rank)),
          // A sentinel rather than nothing: a stale "2 min" left over from the
          // last read would read as a bus that is never coming.
          state: departure
            ? Math.min(departure.minutes, NO_DEPARTURE_MINUTES)
            : NO_DEPARTURE_MINUTES,
        });
        states.push({
          device_feature_external_id: ids.feature(departureRouteFeatureKey(rank)),
          text: departure ? departure.route : '',
        });
      }

      const updates = changedStates(states);
      if (updates.length > 0) {
        await publishDeviceStates(gladys, ids.device, updates);
      }
      // The whole board, not the published slice: the scene triggers watch
      // every route of the stop (see src/scenes/triggers.js).
      return departures;
    },
  };
}
