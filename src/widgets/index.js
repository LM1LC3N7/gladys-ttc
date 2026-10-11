// -----------------------------------------------------------------------------
// Dashboard widgets (manifest `widgets`, Gladys >= 5.1.0).
//
// The devices already put every value on the dashboard, one feature per tile,
// and that is exactly what a departure board is bad at. A widget is a card
// the integration composes itself:
//   - departures   : the board of a stop, soonest first;
//   - line_status  : the lines, colored, with the operator's message for any
//                    line that is not running normally;
//   - bike_station : bikes, e-bikes and docks, the fill gauge, the day's curve.
//
// Each card reads through the same `read` as the poll, and takes the poll's
// last reading while it is younger than the card's own lifetime on the
// dashboard (src/devices/readings.js): a dashboard left open on a tablet must
// not read the operator's API for nothing.
//
// Nothing here throws at the dashboard. A device of the wrong kind, a device
// removed from the watch lists or an API that is down all render as a card
// saying so — an empty or failed widget tells the user nothing.
// -----------------------------------------------------------------------------

import {
  createLogger,
  WIDGET_CHART_INTERVALS,
  WIDGET_COLORS,
  WIDGET_TEXT_VARIANTS,
} from '@gladysassistant/integration-sdk';
import {
  DeviceSelectionError,
  deviceName,
  findSelectedBlueprint,
  linesBlueprint,
} from '../devices/index.js';
import { createdFeatures } from '../devices/publish.js';
import { sharedReading } from '../devices/readings.js';
import { DEVICE_TYPE as STOP_TYPE } from '../devices/stop.js';
import { STATUS_LABELS } from '../devices/lineStatus.js';
import {
  computeOccupancy,
  DEVICE_TYPE as BIKE_TYPE,
  FEATURE as BIKE_FEATURE,
  formatStatus as formatBikeStatus,
} from '../devices/bikeStation.js';
import { LINE_STATUS } from '../api/lines.js';
import { RealtimeApiError } from '../api/realtime.js';
import { NETWORK } from '../network.js';

const logger = createLogger({ name: 'widgets' });

/** Keys of the `widgets` declared in the manifest. Never rename one. */
export const WIDGET_KEYS = {
  DEPARTURES: 'departures',
  LINE_STATUS: 'line_status',
  BIKE_STATION: 'bike_station',
};

// How long the core may serve a card before pulling it again.
const TTL_SECONDS = {
  [WIDGET_KEYS.DEPARTURES]: 30,
  [WIDGET_KEYS.LINE_STATUS]: 120,
  [WIDGET_KEYS.BIKE_STATION]: 60,
};

// The core waits 15 s for a widget, then shows "data unavailable" until the
// dashboard is reloaded. Past this deadline the card says it is loading, and
// the read keeps going: it is remembered, so the re-pull finds it.
export const PULL_DEADLINE_MS = 9000;
const LOADING_TTL_SECONDS = 15;

// The core caps a status list at ten rows, and a card is read at a glance.
const BOARD_ROWS = 8;
// The content budget of the widget contract (see the SDK's
// validateWidgetContent): a body text holds 300 characters, a heading 40.
const BODY_MAX = 300;
const HEADING_MAX = 40;

const { NEUTRAL, SUCCESS, WARNING, DANGER, INFO } = WIDGET_COLORS;

/** Cut a text to a budget, with an ellipsis when it was longer. */
export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Settle with the promise, or with null once the deadline passed.
 * @param {Promise<object>} promise
 * @param {number} deadlineMs
 * @returns {Promise<object|null>}
 */
function withDeadline(promise, deadlineMs) {
  promise.catch((err) => logger.debug(`Widget read failed after the deadline: ${err.message}`));
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A one-paragraph card, for everything that is not data. */
function messageContent(ttlSeconds, message) {
  return {
    ttl_seconds: ttlSeconds,
    components: [{ type: 'text', variant: WIDGET_TEXT_VARIANTS.BODY, text: message }],
  };
}

const heading = (name) => ({
  type: 'text',
  variant: WIDGET_TEXT_VARIANTS.HEADING,
  text: truncate(name, HEADING_MAX),
});

/**
 * The countdown of one departure as the board displays it.
 * @param {number} minutes
 */
function formatMinutes(minutes) {
  return minutes === 0 ? { en: 'Now', fr: 'À l’arrêt' } : `${minutes} min`;
}

/**
 * The card of a stop: the next departure as a tile, the board below.
 *
 * @param {string} name
 * @param {{ route: string, minutes: number, delaySeconds?: number }[]} departures
 */
export function departuresContent(name, departures) {
  const components = [heading(name)];
  const [next] = departures;
  if (!next) {
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.BODY,
      text: { en: 'No upcoming departure.', fr: 'Aucun passage à venir.' },
    });
    return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.DEPARTURES], components };
  }

  const scheduled = departures.slice(0, BOARD_ROWS).some((departure) => !departure.realtime);
  components.push({
    type: 'value',
    value: next.minutes,
    unit: 'min',
    label: routeLabel(next, 24),
    icon: 'clock',
    color: next.realtime ? SUCCESS : NEUTRAL,
  });
  components.push({
    type: 'status',
    items: departures.slice(0, BOARD_ROWS).map((departure) => ({
      label: routeLabel(departure, 40),
      value: departure.realtime
        ? formatMinutes(departure.minutes)
        : formatScheduled(departure.minutes),
      // Green is a vehicle the operator tracks, grey the timetable; a tracked
      // one more than five minutes late is worth a glance before leaving.
      color: !departure.realtime
        ? NEUTRAL
        : (departure.delaySeconds ?? 0) > 300
          ? WARNING
          : SUCCESS,
    })),
  });
  if (scheduled) {
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.CAPTION,
      // An open feed needs no key: its scheduled times are the stops it
      // leaves out (the TTC subway), which no key would change.
      text:
        NETWORK.realtime && !NETWORK.realtime.keyless
          ? {
              en: `~ scheduled time. Add a ${NETWORK.operator} key for real time.`,
              fr: `~ horaire prévu. Ajoutez une clé ${NETWORK.operator} pour le temps réel.`,
            }
          : { en: '~ scheduled time.', fr: '~ horaire prévu.' },
    });
  }
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.DEPARTURES], components };
}

/**
 * "Route 99 → UBC": the route, and where it goes when the source said so.
 * @param {{ route: string, headsign?: string }} departure
 * @param {number} max the budget of the component
 */
function routeLabel(departure, max) {
  const direction = departure.headsign ? ` → ${departure.headsign}` : '';
  return {
    en: truncate(`Route ${departure.route}${direction}`, max),
    fr: truncate(`Ligne ${departure.route}${direction}`, max),
  };
}

/** A scheduled countdown, marked "~". */
function formatScheduled(minutes) {
  return minutes === 0 ? { en: '~ Now', fr: '~ À l’arrêt' } : `~${minutes} min`;
}

const LINE_COLORS = {
  [LINE_STATUS.NORMAL]: SUCCESS,
  [LINE_STATUS.DISRUPTED]: DANGER,
  [LINE_STATUS.NOTICE]: WARNING,
  [LINE_STATUS.UNKNOWN]: NEUTRAL,
};

/**
 * The card of the lines: one row per line, then the message of each line
 * that is not running normally.
 *
 * @param {{ lines: { id: string, name: { en: string, fr: string }, status: string,
 *   message: string }[] }} status
 */
export function lineStatusContent(status) {
  const components = [heading(NETWORK.linesName)];
  components.push({
    type: 'status',
    items: status.lines.map((line) => ({
      label: line.name,
      value: STATUS_LABELS[line.status],
      color: LINE_COLORS[line.status],
    })),
  });
  for (const line of status.lines) {
    if (line.status === LINE_STATUS.NORMAL || !line.message) continue;
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.BODY,
      // The message is in the language of the configuration (a text feature
      // holds one string); the line name follows the viewer's.
      text: {
        en: truncate(`${line.name.en}: ${line.message}`, BODY_MAX),
        fr: truncate(`${line.name.fr} : ${line.message}`, BODY_MAX),
      },
    });
  }
  if (status.lines.every((line) => line.status === LINE_STATUS.UNKNOWN)) {
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.CAPTION,
      text: {
        en: `${NETWORK.operator} published no status for the lines.`,
        fr: `${NETWORK.operator} n’a publié aucun état pour les lignes.`,
      },
    });
  }
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.LINE_STATUS], components };
}

/**
 * The card of a bike station.
 *
 * @param {string} name
 * @param {object} station a reading of the station (src/api/bikes.js)
 * @param {string[]} chartFeatures feature external_ids to draw the day of
 */
export function bikeStationContent(name, station, chartFeatures = []) {
  const components = [heading(name)];
  if (station.absent) {
    // Three tiles reading 0 would say "empty station"; the station is gone.
    components.push({
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.BODY,
      text: {
        en: `This station is no longer in the ${NETWORK.bike?.name} network, probably removed for the season. It will show up again when it is put back.`,
        fr: `Cette station n’est plus dans le réseau ${NETWORK.bike?.name}, probablement retirée pour la saison. Elle réapparaîtra quand elle sera remise en place.`,
      },
    });
    components.push({
      type: 'status',
      items: [
        {
          label: { en: 'State', fr: 'État' },
          value: { en: 'Removed', fr: 'Retirée' },
          color: DANGER,
        },
      ],
    });
    return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.BIKE_STATION], components };
  }
  if (Number.isFinite(station.bikes)) {
    components.push({
      type: 'value',
      value: station.bikes,
      label: { en: 'Bikes', fr: 'Vélos' },
      color: station.bikes === 0 ? DANGER : SUCCESS,
    });
  }
  if (Number.isFinite(station.electricBikes)) {
    components.push({
      type: 'value',
      value: station.electricBikes,
      label: { en: 'E-bikes', fr: 'Vélos électriques' },
      icon: 'zap',
      color: INFO,
    });
  }
  if (Number.isFinite(station.docks)) {
    components.push({
      type: 'value',
      value: station.docks,
      label: { en: 'Free docks', fr: 'Ancrages libres' },
      color: station.docks === 0 ? WARNING : NEUTRAL,
    });
  }
  const occupancy = computeOccupancy(station);
  if (occupancy !== null) {
    components.push({
      type: 'gauge',
      value: occupancy,
      min: 0,
      max: 100,
      unit: '%',
      label: { en: 'Fill', fr: 'Remplissage' },
    });
  }
  if (chartFeatures.length > 0) {
    components.push({
      type: 'chart',
      device_features: chartFeatures,
      interval: WIDGET_CHART_INTERVALS.LAST_DAY,
      chart_type: 'line',
      title: { en: 'Last 24 hours', fr: 'Dernières 24 heures' },
    });
  }
  const ok = station.installed && station.renting && station.returning;
  components.push({
    type: 'status',
    items: [
      {
        label: { en: 'State', fr: 'État' },
        value: {
          en: truncate(formatBikeStatus(station, 'en'), 40),
          fr: truncate(formatBikeStatus(station, 'fr'), 40),
        },
        color: !station.installed ? DANGER : ok && station.bikes !== 0 ? SUCCESS : WARNING,
      },
    ],
  });
  return { ttl_seconds: TTL_SECONDS[WIDGET_KEYS.BIKE_STATION], components };
}

/**
 * The curves of a device, restricted to the features the created device
 * actually carries: a chart pointing at a missing feature is an empty frame.
 */
function chartableFeatures(gladys, deviceExternalId, featureExternalIds) {
  const created = createdFeatures(gladys, deviceExternalId);
  return created ? featureExternalIds.filter((id) => created.has(id)) : [];
}

/** The poll's last reading when fresh enough, else one shared read. */
function latestReading(blueprint, config, widgetKey) {
  return sharedReading(blueprint, config, { maxAgeMs: TTL_SECONDS[widgetKey] * 1000 });
}

const RAW_WIDGETS = {
  async [WIDGET_KEYS.DEPARTURES](gladys, { settings, config }) {
    const blueprint = findSelectedBlueprint(gladys, settings.stop, config, STOP_TYPE);
    const departures = await latestReading(blueprint, config, WIDGET_KEYS.DEPARTURES);
    return departuresContent(deviceName(gladys, blueprint, config), departures);
  },

  async [WIDGET_KEYS.LINE_STATUS](gladys, { config }) {
    const blueprint = linesBlueprint(config);
    const status = await latestReading(blueprint, config, WIDGET_KEYS.LINE_STATUS);
    return lineStatusContent(status);
  },

  async [WIDGET_KEYS.BIKE_STATION](gladys, { settings, config }) {
    const blueprint = findSelectedBlueprint(gladys, settings.station, config, BIKE_TYPE);
    const station = await latestReading(blueprint, config, WIDGET_KEYS.BIKE_STATION);
    const ids = gladys.externalIds(BIKE_TYPE, blueprint.station.id);
    const chart = chartableFeatures(gladys, ids.device, [
      ids.feature(BIKE_FEATURE.BIKES),
      ids.feature(BIKE_FEATURE.DOCKS),
    ]);
    return bikeStationContent(deviceName(gladys, blueprint, config), station, chart);
  },
};

// The cards of the features this network has.
const AVAILABLE_WIDGETS = Object.entries(RAW_WIDGETS).filter(
  ([key]) =>
    (key !== WIDGET_KEYS.LINE_STATUS || NETWORK.lines.length > 0) &&
    (key !== WIDGET_KEYS.BIKE_STATION || NETWORK.bike),
);

/**
 * Handlers of the widgets, by key, with every failure turned into a card that
 * says what is wrong.
 */
export const WIDGETS = Object.fromEntries(
  AVAILABLE_WIDGETS.map(([key, handler]) => [
    key,
    async (gladys, context, { deadlineMs = PULL_DEADLINE_MS } = {}) => {
      try {
        const content = await withDeadline(handler(gladys, context), deadlineMs);
        if (content === null) {
          logger.info(`Widget ${key}: no answer within ${deadlineMs} ms, serving a loading card`);
          return messageContent(LOADING_TTL_SECONDS, {
            en: 'Reading the data, this takes longer than usual…',
            fr: 'Lecture des données, plus longue que d’habitude…',
          });
        }
        return content;
      } catch (err) {
        if (err instanceof DeviceSelectionError) {
          return messageContent(TTL_SECONDS[key], err.userMessage);
        }
        if (err instanceof RealtimeApiError && err.userMessage) {
          logger.warn(`Widget ${key} failed: ${err.message}`);
          return messageContent(TTL_SECONDS[key], err.userMessage);
        }
        logger.warn(`Widget ${key} failed: ${err.message}`);
        return messageContent(TTL_SECONDS[key], {
          en: truncate(`The data could not be read right now (${err.message}).`, BODY_MAX),
          fr: truncate(
            `Les données n’ont pas pu être lues pour l’instant (${err.message}).`,
            BODY_MAX,
          ),
        });
      }
    },
  ]),
);
