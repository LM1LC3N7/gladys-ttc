// -----------------------------------------------------------------------------
// Device type: BIKE STATION
//
// One device per bike-share station the user watches (NETWORK.bike).
// Read-only, refreshed at `bike_poll_frequency` from the open GBFS feed (no
// key, no quota).
//
// Features:
//   - Bikes          : bikes available, e-bikes included (counter sensor)
//   - Electric bikes : e-bikes available                  (counter sensor)
//   - Free docks     : docks available                    (counter sensor)
//   - Status         : OK / no bike / no dock / out of service (text sensor)
//
// The counts keep an history: "is there still a bike at 8:15 on weekdays" is
// what a week of curve answers.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_TRANSPORTS,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { TEXT_FEATURE_RANGE } from './featureRange.js';
import { changedStates } from './stateCache.js';
import { publishDeviceStates } from './publish.js';
import { fetchStation, knownStationName } from '../api/bikes.js';
import { NETWORK } from '../network.js';

export const DEVICE_TYPE = 'bike-station';
const BIKE_SHARE = NETWORK.bike?.name ?? '';

const logger = createLogger({ name: DEVICE_TYPE });

/** Feature keys. Never rename one: Gladys keys the history on them. */
export const FEATURE = {
  BIKES: 'bikes',
  ELECTRIC_BIKES: 'electric_bikes',
  DOCKS: 'docks',
  STATUS: 'status',
};

// The largest stations hold a few dozen docks; the gauge only needs a
// ceiling no station reaches.
const MAX_COUNT = 200;

/** What every bike station device name starts with (see stop.js). */
export const NAME_PREFIX = NETWORK.bike?.prefix ?? '';

const LABELS = {
  en: {
    station: 'station',
    bikes: 'Bikes',
    electricBikes: 'Electric bikes',
    docks: 'Free docks',
    status: 'Status',
  },
  fr: {
    station: 'station',
    bikes: 'Vélos',
    electricBikes: 'Vélos électriques',
    docks: 'Points d’ancrage libres',
    status: 'État',
  },
};

// A station absent from the feed is read every quarter of an hour, not every
// two minutes: it comes back with the season, not within the minute, and a
// device left in Gladys all winter must not read the network for nothing.
export const ABSENT_POLL_SECONDS = 15 * 60;

/** The stations currently absent from the feed, by id. */
const absentStations = new Set();
/**
 * The stations whose badge this process has already published. The first read
 * of a station after a (re)start always publishes it: a station that came
 * back while the container was stopped must not keep the orange dot of the
 * winter forever.
 */
const badgePublished = new Set();

/** Forget which stations are absent (tests). */
export function clearAbsentStations() {
  absentStations.clear();
  badgePublished.clear();
}

const STATUS_TEXT = {
  en: {
    removed: `Removed from the ${BIKE_SHARE} network (seasonal?)`,
    ok: 'OK',
    outOfService: 'Out of service',
    noRental: 'no rental',
    noReturn: 'no return',
    noBike: 'no bike',
    noDock: 'no free dock',
  },
  fr: {
    removed: `Retirée du réseau ${BIKE_SHARE} (saisonnier ?)`,
    ok: 'OK',
    outOfService: 'Hors service',
    noRental: 'location impossible',
    noReturn: 'retour impossible',
    noBike: 'aucun vélo',
    noDock: 'aucun point d’ancrage libre',
  },
};

/**
 * The state of a station, in one language.
 * @param {{ installed: boolean, renting: boolean, returning: boolean,
 *   bikes?: number, docks?: number }} station
 * @param {string} language
 */
export function formatStatus(station, language = 'fr') {
  const text = STATUS_TEXT[language];
  if (station.absent) {
    return text.removed;
  }
  if (!station.installed) {
    return text.outOfService;
  }
  const issues = [];
  if (!station.renting) issues.push(text.noRental);
  if (!station.returning) issues.push(text.noReturn);
  if (station.bikes === 0) issues.push(text.noBike);
  if (station.docks === 0) issues.push(text.noDock);
  return issues.length === 0 ? text.ok : issues.join(', ');
}

/**
 * The fill of a station, in percent of its docks holding a bike.
 * @param {{ bikes?: number, docks?: number }} station
 * @returns {number | null}
 */
export function computeOccupancy(station) {
  if (!Number.isFinite(station.bikes) || !Number.isFinite(station.docks)) {
    return null;
  }
  const total = station.bikes + station.docks;
  return total > 0 ? Math.round((station.bikes / total) * 100) : null;
}

/**
 * Device name when the user did not give one: the bike share prefix then the station name
 * (from the suggestion, else from the last read of the network), else its id.
 * @param {{ id: string, name: string | null, label?: string }} station
 * @param {string} language
 */
export function deviceName(station, language) {
  if (station.name) {
    return station.name;
  }
  const place = station.label || knownStationName(station.id);
  return `${NAME_PREFIX}${place || `${LABELS[language].station} ${station.id}`}`;
}

/**
 * Follow a station leaving and coming back to the feed: one log line and one
 * badge change per transition, not one per read all winter long.
 *
 * The badge is the orange dot of the device in Gladys, with the reason in its
 * tooltip: somebody wondering why a station shows 0 bikes since November
 * looks at the device, not at the container logs. It is best effort, like
 * every transport badge (an older Gladys has no such endpoint).
 *
 * @param {object} gladys
 * @param {string} deviceExternalId
 * @param {string} id
 * @param {{ absent?: boolean }} live
 */
async function noteAbsence(gladys, deviceExternalId, id, live) {
  const wasAbsent = absentStations.has(id);
  const changed = Boolean(live.absent) !== wasAbsent;
  if (!changed && badgePublished.has(id)) {
    return;
  }
  const entry = { external_id: deviceExternalId, transport: DEVICE_TRANSPORTS.CLOUD };
  if (live.absent && changed) {
    absentStations.add(id);
    logger.warn(
      `${BIKE_SHARE} station ${id} is no longer in the network feed (removed for the winter?): ` +
        `it is now shown as removed and read every ${ABSENT_POLL_SECONDS / 60} minutes`,
    );
    entry.degraded = true;
    entry.message = {
      en: `This station is no longer in the ${BIKE_SHARE} network (removed for the season?).`,
      fr: `Cette station n’est plus dans le réseau ${BIKE_SHARE} (retirée pour la saison ?).`,
    };
  } else if (changed) {
    absentStations.delete(id);
    logger.info(`${BIKE_SHARE} station ${id} is back in the network feed`);
  }
  badgePublished.add(id);
  try {
    await gladys.publishTransports?.([entry]);
  } catch (err) {
    logger.debug(`Transport badge of station ${id} not published: ${err.message}`);
  }
}

/**
 * The blueprint of one watched station.
 * @param {{ id: string, name: string | null }} station
 */
export function createBikeStationBlueprint(station) {
  return {
    key: `${DEVICE_TYPE}:${station.id}`,
    type: DEVICE_TYPE,
    station,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, station.id).device;
    },

    pollIntervalMs(config) {
      const seconds = absentStations.has(station.id)
        ? Math.max(config.bike_poll_frequency, ABSENT_POLL_SECONDS)
        : config.bike_poll_frequency;
      return seconds * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, station.id);
      const labels = LABELS[config.language];
      const counter = (key, name) => ({
        name,
        external_id: ids.feature(key),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: MAX_COUNT,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      });

      return {
        name: deviceName(station, config.language),
        external_id: ids.device,
        poll_frequency: gladysPollFrequency(config.bike_poll_frequency),
        should_poll: true,
        params: [{ name: 'station_id', value: station.id }],
        features: [
          counter(FEATURE.BIKES, labels.bikes),
          counter(FEATURE.ELECTRIC_BIKES, labels.electricBikes),
          counter(FEATURE.DOCKS, labels.docks),
          {
            name: labels.status,
            external_id: ids.feature(FEATURE.STATUS),
            category: DEVICE_FEATURE_CATEGORIES.TEXT,
            type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
            ...TEXT_FEATURE_RANGE,
            read_only: true,
            has_feedback: false,
            keep_history: false,
          },
        ],
      };
    },

    /** The live counts of the station (see src/api/bikes.js). */
    read(config) {
      return fetchStation(config, station);
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, station.id);
      const live = await this.read(config);
      await noteAbsence(gladys, ids.device, station.id, live);

      logger.info(
        `${BIKE_SHARE} ${station.id}: ${live.bikes ?? '?'} bike(s), ${live.docks ?? '?'} free dock(s)`,
      );

      const states = [];
      const pushCount = (key, value) => {
        // A count the feed did not send is left alone rather than published
        // as 0: "no information" is not "no bike".
        if (Number.isFinite(value)) {
          states.push({ device_feature_external_id: ids.feature(key), state: value });
        }
      };
      pushCount(FEATURE.BIKES, live.bikes);
      pushCount(FEATURE.ELECTRIC_BIKES, live.electricBikes);
      pushCount(FEATURE.DOCKS, live.docks);
      states.push({
        device_feature_external_id: ids.feature(FEATURE.STATUS),
        text: formatStatus(live, config.language),
      });

      const updates = changedStates(states);
      if (updates.length > 0) {
        await publishDeviceStates(gladys, ids.device, updates);
      }
      return live;
    },
  };
}
