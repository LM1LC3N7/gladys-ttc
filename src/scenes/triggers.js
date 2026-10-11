// -----------------------------------------------------------------------------
// Scene triggers (manifest `scene_triggers`, Gladys >= 5.1.0).
//
// A device feature is a state, and Gladys already knows how to start a scene
// on a state. A scene trigger is the other thing: an event, something that
// HAPPENED between two reads — a line just went down, the bus crossed the
// "5 minutes away" mark, the last bike of a station was taken. The core
// matches the event against the filters the scene author configured, and it
// only does equality and membership: every threshold is decided here, and
// travels as a plain value the scene can compare for equality.
//
// Events are computed from two consecutive reads of the same device, in the
// poll path (see `pollDevice` in src/devices/index.js):
//   - nothing fires on the first read after a start: there is no transition
//     without a previous value, and a container restart must not announce
//     that a line "just went back to normal";
//   - a value the feed did not send is not a transition either.
//
// A failed publication only costs the event: the poll has already published
// its states.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE as STOP_TYPE } from '../devices/stop.js';
import { DEVICE_TYPE as LINES_TYPE } from '../devices/lineStatus.js';
import { DEVICE_TYPE as BIKE_TYPE } from '../devices/bikeStation.js';
import { LINE_STATUS } from '../api/lines.js';

const logger = createLogger({ name: 'scenes' });

/** Keys of the `scene_triggers` declared in the manifest. Never rename one. */
export const SCENE_TRIGGERS = {
  DEPARTURE_APPROACHING: 'departure_approaching',
  LINE_STATUS_CHANGED: 'line_status_changed',
  BIKE_STATION_CHANGED: 'bike_station_changed',
};

/**
 * The "minutes before the departure" marks a scene can wait for. They are the
 * options of the `threshold` select of the manifest: test/manifest.test.js
 * keeps both lists identical.
 */
export const DEPARTURE_THRESHOLDS = [1, 2, 3, 5, 10, 15];

/** Values of the `event` field of the line trigger. */
export const LINE_EVENTS = {
  DISRUPTED: 'disrupted',
  RESTORED: 'restored',
  NOTICE: 'notice',
};

/** Values of the `event` field of the bike station trigger. */
export const BIKE_EVENTS = {
  NO_BIKE: 'no_bike',
  BIKES_BACK: 'bikes_back',
  NO_DOCK: 'no_dock',
  DOCKS_BACK: 'docks_back',
  OUT_OF_SERVICE: 'out_of_service',
  BACK_IN_SERVICE: 'back_in_service',
};

/** @type {Map<string, unknown>} previous reading, per blueprint key. */
const previousReadings = new Map();

/** Forget every previous reading (configuration change, tests). */
export function clearSceneMemory() {
  previousReadings.clear();
}

const isCount = (value) => Number.isFinite(value);

/**
 * The thresholds each bus of a stop crossed between two reads.
 *
 * Unlike a feed that only gives countdowns, GTFS-Realtime identifies the trip:
 * a bus is followed by its trip_id, so the next bus of the same route taking
 * the place of the one that just left is never mistaken for a crossing. Every
 * mark crossed fires, not only the closest one: a stop read every five minutes
 * can go from 11 to 4 in one step, and a scene waiting for "10" is as entitled
 * to run as one waiting for "5". A trip absent from the previous read is not
 * followed yet — it appeared, it did not approach.
 *
 * @param {{ tripId?: string, route: string, minutes: number }[]} previous
 * @param {{ tripId?: string, route: string, minutes: number }[]} current
 * @returns {{ departure: object, threshold: number }[]}
 */
export function departureCrossings(previous, current) {
  const before = new Map(
    previous.filter((departure) => departure.tripId).map((d) => [d.tripId, d.minutes]),
  );
  const crossings = [];
  for (const departure of current) {
    const was = departure.tripId ? before.get(departure.tripId) : undefined;
    if (was === undefined) continue;
    for (const threshold of DEPARTURE_THRESHOLDS) {
      if (was > threshold && departure.minutes <= threshold) {
        crossings.push({ departure, threshold });
      }
    }
  }
  return crossings;
}

/**
 * The line events between two reads: one per line whose status changed.
 *
 * "Unknown" is a hole in the feed, not a status: a line going from disrupted
 * to unknown has not been restored, and one going from unknown to normal was
 * never down.
 *
 * @param {{ lines: { id: string, status: string }[] }} previous
 * @param {{ lines: { id: string, status: string, message: string }[] }} current
 * @returns {{ line: object, event: string }[]}
 */
export function lineEvents(previous, current) {
  const before = new Map((previous?.lines ?? []).map((line) => [line.id, line.status]));
  const events = [];
  for (const line of current?.lines ?? []) {
    const was = before.get(line.id);
    if (!was || was === LINE_STATUS.UNKNOWN || line.status === LINE_STATUS.UNKNOWN) continue;
    if (was === line.status) continue;
    if (line.status === LINE_STATUS.DISRUPTED) {
      events.push({ line, event: LINE_EVENTS.DISRUPTED });
    } else if (line.status === LINE_STATUS.NORMAL) {
      events.push({ line, event: LINE_EVENTS.RESTORED });
    } else if (line.status === LINE_STATUS.NOTICE && was === LINE_STATUS.NORMAL) {
      // A notice after a disruption is the service resuming: the RESTORED
      // event follows once the line is back to normal.
      events.push({ line, event: LINE_EVENTS.NOTICE });
    }
  }
  return events;
}

/**
 * The bike station events between two reads of one station.
 *
 * @param {{ bikes?: number, docks?: number, installed?: boolean }} previous
 * @param {{ bikes?: number, docks?: number, installed?: boolean }} current
 * @returns {string[]} values of BIKE_EVENTS
 */
export function bikeStationEvents(previous, current) {
  // A station leaving the feed (removed for the winter) is one event, not
  // three: it reads as 0 bikes and 0 docks too, and "no bike left" plus "no
  // free dock" on top of "out of service" would run three scenes for one
  // fact. Its return is likewise one "back in service".
  if (current.absent && !previous.absent) {
    return previous.installed === false ? [] : [BIKE_EVENTS.OUT_OF_SERVICE];
  }
  if (previous.absent && !current.absent) {
    return current.installed === false ? [] : [BIKE_EVENTS.BACK_IN_SERVICE];
  }
  if (current.absent) {
    return [];
  }
  const events = [];
  if (isCount(previous.bikes) && isCount(current.bikes)) {
    if (previous.bikes > 0 && current.bikes === 0) events.push(BIKE_EVENTS.NO_BIKE);
    if (previous.bikes === 0 && current.bikes > 0) events.push(BIKE_EVENTS.BIKES_BACK);
  }
  if (isCount(previous.docks) && isCount(current.docks)) {
    if (previous.docks > 0 && current.docks === 0) events.push(BIKE_EVENTS.NO_DOCK);
    if (previous.docks === 0 && current.docks > 0) events.push(BIKE_EVENTS.DOCKS_BACK);
  }
  if (previous.installed === true && current.installed === false) {
    events.push(BIKE_EVENTS.OUT_OF_SERVICE);
  }
  if (previous.installed === false && current.installed === true) {
    events.push(BIKE_EVENTS.BACK_IN_SERVICE);
  }
  return events;
}

/**
 * The scene events a read produced, as `{ key, data }` ready for
 * `publishSceneEvent`.
 *
 * The device fields (`stop`, `station`) are `source: "devices"` selects: the
 * core compares the external_id sent here with the device the author picked.
 * The line trigger has no device field — there is one line status device —
 * but a `line` select instead.
 *
 * @param {object} blueprint the blueprint that was read
 * @param {string} deviceExternalId
 * @param {string} name the name of the device, for the scene variables
 * @param {unknown} previous the reading before this one
 * @param {unknown} current the reading that was just made
 * @param {string} language
 * @returns {{ key: string, data: Record<string, string | number | boolean | null> }[]}
 */
export function sceneEventsBetween(
  blueprint,
  deviceExternalId,
  name,
  previous,
  current,
  language = 'fr',
) {
  switch (blueprint.type) {
    case STOP_TYPE:
      return departureCrossings(previous, current).map(({ departure, threshold }) => ({
        key: SCENE_TRIGGERS.DEPARTURE_APPROACHING,
        data: {
          stop: deviceExternalId,
          stop_name: name,
          route: departure.route,
          threshold: String(threshold),
          minutes: departure.minutes,
        },
      }));
    case LINES_TYPE:
      return lineEvents(previous, current).map(({ line, event }) => ({
        key: SCENE_TRIGGERS.LINE_STATUS_CHANGED,
        data: {
          line: line.id,
          line_name: line.name[language],
          event,
          message: line.message,
        },
      }));
    case BIKE_TYPE:
      return bikeStationEvents(previous, current).map((event) => ({
        key: SCENE_TRIGGERS.BIKE_STATION_CHANGED,
        data: {
          station: deviceExternalId,
          station_name: name,
          event,
          bikes: current.bikes ?? null,
          electric_bikes: current.electricBikes ?? null,
          docks: current.docks ?? null,
        },
      }));
    default:
      return [];
  }
}

/**
 * Remember a fresh reading of a device and fire the scene events it produced.
 *
 * @param {object} gladys
 * @param {object} blueprint
 * @param {string} name the name of the device, for the scene variables
 * @param {unknown} reading what `blueprint.onPoll` returned
 * @param {string} [language]
 */
export async function publishSceneEvents(gladys, blueprint, name, reading, language) {
  if (reading === undefined || reading === null) {
    return;
  }
  const previous = previousReadings.get(blueprint.key);
  previousReadings.set(blueprint.key, reading);
  if (previous === undefined) {
    return;
  }

  const events = sceneEventsBetween(
    blueprint,
    blueprint.deviceExternalId(gladys),
    name,
    previous,
    reading,
    language,
  );
  for (const { key, data } of events) {
    try {
      await gladys.publishSceneEvent(key, data);
      logger.info(`Scene event ${key} fired for ${name}`);
    } catch (err) {
      logger.warn(`Scene event ${key} for ${name} could not be published: ${err.message}`);
    }
  }
}
