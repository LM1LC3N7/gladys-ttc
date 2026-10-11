// -----------------------------------------------------------------------------
// Device registry.
//
// The device list is not a static catalog. One device is built per entry of
// three sources, merged by device identity:
//   1. the configuration: the stops and stations the user typed, and the
//      lines when they are watched (and an operator key is set);
//   2. the suggestions: the stops and stations closest to the house
//      (src/devices/suggestions.js);
//   3. the devices the user already created: rebuilt from their own params, so
//      a device keeps refreshing once it stops being suggested, or after the
//      entry that created it was removed from the configuration — the user
//      deletes a device in Gladys, not in a text field.
//
// Each blueprint (see the three modules of this folder) exposes:
//   - key                        : short identifier, used in logs and caches
//   - type                       : the device type
//   - deviceExternalId(gladys)   : the device external_id, used for dispatch
//   - pollIntervalMs(config)     : the configured refresh interval
//   - buildDevice(gladys, config): the discovery payload sent to Gladys
//   - read(config)               : one fresh read, no publication (the
//                                  widgets and the scene actions use it)
//   - onPoll(gladys, config)     : periodic read, publishes the states and
//                                  returns the reading (the scene triggers
//                                  compare two of them)
//
// Nothing here is controllable: transit data is read-only, so no blueprint
// implements onSetValue.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createStopBlueprint, DEVICE_TYPE as STOP_TYPE } from './stop.js';
import { createLineStatusBlueprint, DEVICE_TYPE as LINES_TYPE } from './lineStatus.js';
import { createBikeStationBlueprint, DEVICE_TYPE as BIKE_TYPE } from './bikeStation.js';
import { dueForRead, forgetRead, readFailed } from './pollSchedule.js';
import { recordReading } from './readings.js';
import { forgetDeviceStates } from './stateCache.js';
import { getTripUpdates, RealtimeApiError, setPolledStops } from '../api/realtime.js';
import { fetchLineStatus } from '../api/lines.js';
import { searchStations } from '../api/bikes.js';
import { searchStops } from '../api/stops.js';
import { describeStop, formatRoutes, TransitousError } from '../api/transitous.js';
import { estimatedDailyRequests, hasApiKey, linesEnabled, parseStopEntry } from '../config.js';
import { NETWORK } from '../network.js';
import { getSuggestions } from './suggestions.js';
import { publishSceneEvents } from '../scenes/triggers.js';

const logger = createLogger({ name: 'devices' });

/** The value of a device param, as the SDK lists created devices. */
function paramValue(device, name) {
  const param = (device?.params ?? []).find((candidate) => candidate?.name === name);
  return param?.value === undefined || param?.value === null ? undefined : String(param.value);
}

/**
 * The entries behind the devices the user created: a stop carries its
 * `stop_code` and `routes` params, a bike station its `station_id` (see
 * `buildDevice` in stop.js and bikeStation.js). Their name is the one Gladys
 * holds, so it is left null here.
 *
 * @param {object} gladys
 */
export function createdEntries(gladys) {
  const stops = [];
  const bikeStations = [];
  for (const device of gladys?.devices ?? []) {
    const stopCode = paramValue(device, 'stop_code');
    if (stopCode) {
      const routes = paramValue(device, 'routes');
      const stop = parseStopEntry(routes ? `${stopCode}@${routes.split(',').join('|')}` : stopCode);
      if (stop) stops.push(stop);
      continue;
    }
    const stationId = paramValue(device, 'station_id');
    if (stationId && NETWORK.bike) {
      bikeStations.push({ id: stationId, name: null });
    }
  }
  return { stops, bikeStations };
}

/** Keep the first blueprint of each device: the typed entry wins (its custom name). */
function uniqueBlueprints(blueprints) {
  const seen = new Set();
  return blueprints.filter((blueprint) =>
    seen.has(blueprint.key) ? false : seen.add(blueprint.key),
  );
}

/**
 * Build every blueprint: configuration, suggestions, created devices.
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function buildBlueprints(gladys, config) {
  const suggested = getSuggestions();
  const created = createdEntries(gladys);
  const blueprints = uniqueBlueprints([
    ...(linesEnabled(config) ? [createLineStatusBlueprint()] : []),
    ...config.watched.stops.map(createStopBlueprint),
    ...suggested.stops.map(createStopBlueprint),
    ...created.stops.map(createStopBlueprint),
    ...config.watched.bikeStations.map(createBikeStationBlueprint),
    ...suggested.bikeStations.map(createBikeStationBlueprint),
    ...created.bikeStations.map(createBikeStationBlueprint),
  ]);
  // The real-time decoder keeps the stop time updates of the polled stops
  // only: all of them, not only the typed ones.
  setPolledStops(blueprints.filter((blueprint) => blueprint.type === STOP_TYPE).map((b) => b.stop));
  return blueprints;
}

/**
 * Build the discovery payload for Gladys.
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function buildDiscoveredDevices(gladys, config) {
  return buildBlueprints(gladys, config).map((blueprint) => blueprint.buildDevice(gladys, config));
}

/**
 * Find the blueprint owning a device, from its external_id.
 * @param {object} gladys
 * @param {{ external_id: string }} device
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function findBlueprintByDevice(gladys, device, config) {
  return buildBlueprints(gladys, config).find(
    (blueprint) => blueprint.deviceExternalId(gladys) === device.external_id,
  );
}

/**
 * How many stops are polled: the estimate of the requests counts one feed
 * read per interval as soon as there is one.
 * @param {object} gladys
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export function countStops(gladys, config) {
  return buildBlueprints(gladys, config).filter((blueprint) => blueprint.type === STOP_TYPE).length;
}

/**
 * Handle one `device.poll` from the Gladys scheduler (or from the internal
 * refresh loop): route it to the blueprint owning the device, and skip the
 * ticks that arrive before the configured refresh interval has elapsed.
 *
 * The skipping is what keeps the refresh intervals of the configuration
 * meaningful: the core scheduler tops out at one tick a minute, so without it,
 * a line status configured to refresh every 5 minutes would cost a request
 * every minute.
 *
 * @param {object} gladys
 * @param {{ external_id: string }} device
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export async function pollDevice(gladys, device, config) {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint) {
    // The user removed the entry from the watch list but the device still
    // exists in Gladys: nothing to read, and nothing worth erroring about.
    logger.debug(`onPoll ignored, ${device.external_id} is no longer configured`);
    return;
  }
  const intervalMs = blueprint.pollIntervalMs(config);
  if (!dueForRead(blueprint.key, intervalMs)) {
    logger.debug(`onPoll skipped, ${blueprint.key} was refreshed less than an interval ago`);
    return;
  }
  let reading;
  try {
    reading = await blueprint.onPoll(gladys, config);
  } catch (err) {
    readFailed(blueprint.key, intervalMs);
    throw err;
  }
  recordReading(blueprint.key, reading);
  await publishSceneEvents(
    gladys,
    blueprint,
    deviceName(gladys, blueprint, config),
    reading,
    config.language,
  );
}

/**
 * Read a device the user just created or updated, now, and publish all of it:
 * Gladys dropped whatever was sent before the device existed.
 *
 * @param {object} gladys
 * @param {{ external_id: string }} device
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 */
export async function refreshDeviceNow(gladys, device, config) {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint) {
    return;
  }
  forgetDeviceStates(blueprint.deviceExternalId(gladys));
  forgetRead(blueprint.key);
  await pollDevice(gladys, device, config);
}

/**
 * The name the user sees for a device: the one of the created device (the
 * user may have renamed it in Gladys), else the one it is published with.
 *
 * @param {object} gladys
 * @param {object} blueprint
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @returns {string}
 */
export function deviceName(gladys, blueprint, config) {
  const externalId = blueprint.deviceExternalId(gladys);
  const created = (gladys.devices ?? []).find((device) => device.external_id === externalId);
  return created?.name || blueprint.buildDevice(gladys, config).name;
}

/**
 * Error raised when a widget or a scene action points at a device this
 * integration cannot read: nothing chosen, a device whose entry was removed
 * from the watch lists, or a device of another kind (the `source: "devices"`
 * selects list every device of the integration together). It carries the
 * bilingual explanation the widget displays.
 */
export class DeviceSelectionError extends Error {
  /** @param {{ en: string, fr: string }} userMessage */
  constructor(userMessage) {
    super(userMessage.en);
    this.name = 'DeviceSelectionError';
    this.userMessage = userMessage;
  }
}

const KIND_LABELS = {
  [STOP_TYPE]: { en: 'a stop', fr: 'un arrêt' },
  [LINES_TYPE]: { en: 'the line status', fr: 'l’état des lignes' },
  [BIKE_TYPE]: {
    en: `a ${NETWORK.bike?.name ?? 'bike'} station`,
    fr: `une station ${NETWORK.bike?.name ?? 'de vélos'}`,
  },
};

/**
 * The blueprint behind the device a widget or a scene action was set up with.
 *
 * @param {object} gladys
 * @param {unknown} deviceExternalId the value of the `source: "devices"` field
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {string} type the device type the caller reads
 * @returns {object} the blueprint
 * @throws {DeviceSelectionError}
 */
export function findSelectedBlueprint(gladys, deviceExternalId, config, type) {
  const kind = KIND_LABELS[type];
  if (typeof deviceExternalId !== 'string' || deviceExternalId.length === 0) {
    throw new DeviceSelectionError({
      en: `Choose ${kind.en} in the settings.`,
      fr: `Choisissez ${kind.fr} dans les réglages.`,
    });
  }
  const blueprint = findBlueprintByDevice(gladys, { external_id: deviceExternalId }, config);
  if (!blueprint) {
    throw new DeviceSelectionError({
      en: 'This device is no longer in the integration configuration: add it back, or choose another one.',
      fr: 'Cet appareil n’est plus dans la configuration de l’intégration : ajoutez-le à nouveau, ou choisissez-en un autre.',
    });
  }
  if (blueprint.type !== type) {
    throw new DeviceSelectionError({
      en: `This device is ${KIND_LABELS[blueprint.type]?.en ?? 'another kind of device'}: choose ${kind.en}.`,
      fr: `Cet appareil est ${KIND_LABELS[blueprint.type]?.fr ?? 'd’un autre type'} : choisissez ${kind.fr}.`,
    });
  }
  return blueprint;
}

/**
 * The line status blueprint, when the configuration watches the lines.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @throws {DeviceSelectionError}
 */
export function linesBlueprint(config) {
  if (!config.watched.lines) {
    throw new DeviceSelectionError({
      en: 'The lines are not watched: turn on “Watch the lines” in the integration configuration.',
      fr: 'Les lignes ne sont pas surveillées : activez « Surveiller les lignes » dans la configuration de l’intégration.',
    });
  }
  if (!linesEnabled(config)) {
    throw new DeviceSelectionError({
      en: `The line status needs a ${NETWORK.realtime?.keyLabel?.en ?? 'key'}: see the integration documentation, it takes 5 minutes.`,
      fr: `L’état des lignes demande une ${NETWORK.realtime?.keyLabel?.fr ?? 'clé'} : voir la documentation de l’intégration, c’est 5 minutes.`,
    });
  }
  return createLineStatusBlueprint();
}

/**
 * Handlers of the manifest actions (the buttons of the Configuration screen).
 */
const RAW_ACTIONS = {
  /**
   * Check the key against the feeds the integration reads. They are probed
   * separately: "the predictions work but not the alerts" tells the user
   * which part of their developer account is missing.
   */
  async test_api_key(gladys, { config }) {
    const KEY = NETWORK.realtime.keyLabel;
    if (!hasApiKey(config)) {
      return {
        en: `No ${KEY.en}: fill it in above.`,
        fr: `Aucune ${KEY.fr} : renseignez-la ci-dessus.`,
      };
    }
    const probes = [
      {
        // The probe decodes for the watched stops, which also checks the
        // payload is a well-formed feed.
        label: { en: 'Real-time predictions', fr: 'Prédictions en temps réel' },
        run: () => getTripUpdates(config, { fresh: true }),
      },
      ...(NETWORK.realtime.alertsUrl
        ? [
            {
              label: { en: 'Service alerts', fr: 'Alertes de service' },
              run: () => fetchLineStatus(config),
            },
          ]
        : []),
    ];
    const results = [];
    for (const probe of probes) {
      try {
        await probe.run();
        results.push({ ok: true, label: probe.label });
      } catch (err) {
        results.push({ ok: false, label: probe.label, error: err });
      }
    }
    const lines = results.map((result) => {
      if (result.ok) {
        return { en: `✔ ${result.label.en}`, fr: `✔ ${result.label.fr}` };
      }
      const reason = result.error?.userMessage ?? {
        en: result.error?.message,
        fr: result.error?.message,
      };
      return {
        en: `✖ ${result.label.en}: ${reason.en}`,
        fr: `✖ ${result.label.fr} : ${reason.fr}`,
      };
    });
    const requests = estimatedDailyRequests(config, { stops: countStops(gladys, config) });
    const summary = results.every((result) => result.ok)
      ? {
          en: `${NETWORK.operator} API OK. This configuration costs about ${requests} requests a day.`,
          fr: `API ${NETWORK.operator} OK. Cette configuration coûte environ ${requests} requêtes par jour.`,
        }
      : {
          en: `The ${NETWORK.operator} API refused part of the requests:`,
          fr: `L’API ${NETWORK.operator} a refusé une partie des requêtes :`,
        };
    return {
      en: [summary.en, ...lines.map((line) => line.en)].join('\n'),
      fr: [summary.fr, ...lines.map((line) => line.fr)].join('\n'),
    };
  },

  /**
   * Search a stop by name or code and show the codes to paste, each with where
   * its routes go: the two sides of a street share a name, not a direction.
   */
  async search_stops(gladys, { fields }) {
    const query = String(fields?.query ?? '').trim();
    if (query.length < 2) {
      return { en: 'Type at least 2 characters.', fr: 'Saisissez au moins 2 caractères.' };
    }
    const results = searchStops(query);
    if (results.length === 0) {
      return {
        en: `No ${NETWORK.operator} stop matches "${query}". Try a street name or the number on the sign, e.g. "${NETWORK.examples.search}".`,
        fr: `Aucun arrêt ${NETWORK.operator} ne correspond à « ${query} ». Essayez un nom de rue ou le numéro du panneau, ex. « ${NETWORK.examples.search} ».`,
      };
    }
    const lines = [];
    for (const stop of results) {
      // Transitous is only asked for the directions: a stop without them is
      // still worth listing.
      const description = await describeStop(stop.code).catch(() => null);
      const routes = formatRoutes(description);
      lines.push(`${stop.code} — ${stop.name}${routes ? ` (${routes})` : ''}`);
    }
    return {
      en: `Paste a code in "Stops" (several: separate with commas):\n${lines.join('\n')}`,
      fr: `Collez un code dans « Arrêts » (plusieurs : séparez par des virgules) :\n${lines.join('\n')}`,
    };
  },

  /** Search a bike station by name and show the ids to paste. */
  async search_bike_stations(gladys, { fields, config }) {
    const query = String(fields?.query ?? '').trim();
    if (query.length < 2) {
      return { en: 'Type at least 2 characters.', fr: 'Saisissez au moins 2 caractères.' };
    }
    const results = await searchStations(config, query);
    const name = NETWORK.bike.name;
    if (results.length === 0) {
      return {
        en: `No ${name} station matches "${query}".`,
        fr: `Aucune station ${name} ne correspond à « ${query} ».`,
      };
    }
    const list = results
      .map((station) => `${station.id} — ${station.name} (${station.capacity ?? '?'})`)
      .join('\n');
    return {
      en: `Paste one of these ids in "${name} stations" (capacity in brackets):\n${list}`,
      fr: `Collez un de ces identifiants dans « Stations ${name} » (capacité entre parenthèses) :\n${list}`,
    };
  },
};

// The buttons of the features this network has: no key test without a
// real-time feed or with an open one, no station search without a bike share.
const AVAILABLE_ACTIONS = Object.entries(RAW_ACTIONS).filter(
  ([key]) =>
    (key !== 'test_api_key' || (NETWORK.realtime && !NETWORK.realtime.keyless)) &&
    (key !== 'search_bike_stations' || NETWORK.bike),
);

/**
 * Handlers of the manifest actions, with the operator's refusals turned into
 * what the user can act on: an action that throws shows the raw error under
 * the button.
 */
export const ACTIONS = Object.fromEntries(
  AVAILABLE_ACTIONS.map(([key, handler]) => [
    key,
    async (gladys, context) => {
      try {
        return await handler(gladys, context);
      } catch (err) {
        if (err instanceof RealtimeApiError && err.userMessage) {
          logger.warn(`Action ${key} failed: ${err.message}`);
          return err.userMessage;
        }
        if (err instanceof TransitousError) {
          logger.warn(`Action ${key} failed: ${err.message}`);
          return {
            en: 'The stop directory (Transitous) does not answer right now: try again in a few minutes.',
            fr: 'L’annuaire des arrêts (Transitous) ne répond pas pour l’instant : réessayez dans quelques minutes.',
          };
        }
        throw err;
      }
    },
  ]),
);
