// -----------------------------------------------------------------------------
// Transitous (https://transitous.org): the keyless half of the integration.
//
// Transitous is a free, community-run public transport routing service (MOTIS)
// that loads the operator's timetables — and, for some networks, its real-time
// feed — among a thousand other feeds. It needs no key, and it answers what
// the stop table (src/api/stops.js) cannot: which routes call at a stop, which
// way they go, and when the next ones leave.
//
// Its usage policy (https://transitous.org/api/) asks for a User-Agent naming
// the application and a contact (src/api/http.js sends it), for open-source,
// non-commercial use only, and to stay light: the stop descriptions are cached
// for a day, and the departures are only read when the user has no operator
// key (see src/devices/stop.js), never faster than every two minutes.
//
// Transitous ids are the GTFS ids prefixed with the feed (NETWORK.transitousPrefix).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { request } from './http.js';
import { NETWORK } from '../network.js';
import { normalizeRoute, routeLabel, stopByCode } from './stops.js';

const logger = createLogger({ name: 'transitous' });

export const TRANSITOUS_API_URL = 'https://api.transitous.org/api';

// What a stop is (the routes calling there) only changes with the operator's
// schedule, a few times a year: a day is plenty.
const DESCRIPTION_MAX_AGE_MS = 24 * 60 * 60_000;

/** Error of the Transitous API. */
export class TransitousError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransitousError';
  }
}

async function getJson(path) {
  const response = await request(`${TRANSITOUS_API_URL}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new TransitousError(`Transitous ${path.split('?')[0]} answered HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * The GTFS id behind a Transitous id: `ca-bc-TransLink_6637` → `6637`. Trip
 * ids carry a date before the prefix (`20261011_04:31_ca-bc-TransLink_1551`).
 * @param {unknown} transitousId
 */
export function gtfsId(transitousId) {
  const value = String(transitousId ?? '');
  const at = value.lastIndexOf(NETWORK.transitousPrefix);
  return at === -1 ? value : value.slice(at + NETWORK.transitousPrefix.length);
}

/**
 * The label of the route of a Transitous stop time: the one of the stop table
 * for its route_id, else the names Transitous gives.
 * @param {object} entry
 * @returns {string}
 */
function entryRoute(entry) {
  return String(
    routeLabel(gtfsId(entry?.routeId)) ||
      String(entry?.routeShortName ?? '').replace(/^0+(?=.)/, '') ||
      entry?.routeLongName ||
      entry?.displayName ||
      '',
  );
}

/**
 * A headsign without the route it repeats: TransLink writes "3 Main/To Marine
 * Dr Station" and "Canada Line To YVR-Airport", which a board already showing
 * the route reads as "Main/To Marine Dr Station" and "YVR-Airport"; the TTC
 * "Line 1 (Yonge-University) towards Finch Station", read as "Finch Station".
 * @param {string} headsign
 * @param {string} route
 */
export function tidyHeadsign(headsign, route) {
  let value = String(headsign ?? '').trim();
  const prefix = `${route} `;
  if (route && value.toLowerCase().startsWith(prefix.toLowerCase())) {
    value = value.slice(prefix.length);
  }
  // OC Transpo writes both languages, "Hospital ~ Hôpital": the "~" would
  // read as the scheduled-time mark of the boards.
  value = value.replace(/\s+~\s+/g, ' / ');
  // The TTC writes the direction, the route and its name before the
  // destination: "East - 114 Queens Quay East towards Carlaw".
  const towards = /\btowards\s+(.+)$/i.exec(value);
  if (towards) value = towards[1];
  // Calgary Transit writes its headsigns in capitals, "RICHMOND RD SW": they
  // read better as "Richmond Rd SW" (the city quadrants stay in capitals).
  // Opt-in: elsewhere a headsign in capitals is an acronym, "UBC".
  if (NETWORK.titleCaseHeadsigns && !/[a-z]/.test(value)) {
    value = value
      .toLowerCase()
      .replace(/(^|[\s/(-])\p{L}/gu, (letter) => letter.toUpperCase())
      .replace(/\b(Nw|Ne|Sw|Se)\b/g, (quadrant) => quadrant.toUpperCase());
  }
  return value.replace(/^to\s+/i, '').trim() || String(headsign ?? '').trim();
}

/**
 * The next departures at one Transitous stop id, restricted to the GTFS stops
 * of the code: Transitous answers for every stop of a station group (the bus
 * bays around a SkyTrain station), and the sign of bay 2 is not the sign of
 * bay 1.
 * @param {string} id GTFS stop_id (a station answers for its platforms)
 * @param {number} count
 * @param {Set<string>} ids the GTFS stop_ids the departures may leave from
 */
async function stopTimesAt(id, count, ids) {
  const payload = await getJson(
    `/v5/stoptimes?stopId=${encodeURIComponent(NETWORK.transitousPrefix + id)}&n=${count}`,
  );
  const departures = [];
  for (const entry of Array.isArray(payload?.stopTimes) ? payload.stopTimes : []) {
    if (entry?.cancelled || entry?.tripCancelled) continue;
    const place = entry?.place ?? {};
    if (place.stopId && !ids.has(gtfsId(place.stopId))) continue;
    // A terminus: the trip ends here, nobody boards it.
    if (place.pickupType === 'NOT_ALLOWED') continue;
    const at = Date.parse(place.departure ?? place.arrival);
    const scheduled = Date.parse(place.scheduledDeparture ?? place.scheduledArrival);
    if (!Number.isFinite(at)) continue;
    const route = entryRoute(entry);
    departures.push({
      route,
      headsign: tidyHeadsign(entry.headsign, route),
      tripId: gtfsId(entry.tripId),
      time: Math.floor(at / 1000),
      realtime: entry.realTime === true,
      delaySeconds: Number.isFinite(scheduled) ? Math.round((at - scheduled) / 1000) : 0,
    });
  }
  return departures;
}

/**
 * The next departures of a stop code, from Transitous: the timetable, and the
 * operator's real time where Transitous has it (`realtime: true`).
 *
 * @param {string} code the stop code of the sign
 * @param {{ count?: number }} [options]
 * @returns {Promise<{ route: string, headsign: string, tripId: string, time: number,
 *   realtime: boolean, delaySeconds: number }[]>}
 */
export async function stopTimes(code, { count = 10 } = {}) {
  const stop = stopByCode(code);
  if (!stop) {
    throw new TransitousError(`Stop ${code} is not in the stop table`);
  }
  const ids = new Set(stop.ids);
  const lists = await Promise.all(stop.query.map((id) => stopTimesAt(id, count, ids)));
  return lists.flat().sort((a, b) => a.time - b.time);
}

/** @type {Map<string, { at: number, value: object }>} */
const descriptions = new Map();

/** Forget every stop description (tests). */
export function clearTransitousCache() {
  descriptions.clear();
}

/**
 * The routes calling at a stop, each with its direction — what tells
 * "Davie St @ Bidwell St (6 → Downtown)" from the stop across the street —
 * and the trips seen there, which name the route and the direction of a
 * real-time prediction whose feed only carries the trip. Cached for a day;
 * `null` when Transitous cannot answer (the caller falls back on the stop
 * name).
 *
 * @param {string} code
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ code: string, name: string,
 *   routes: { route: string, headsigns: string[] }[],
 *   trips: Map<string, { route: string, headsign: string }> } | null>}
 */
export async function describeStop(code, { now = Date.now() } = {}) {
  const cached = descriptions.get(code);
  if (cached && now - cached.at < DESCRIPTION_MAX_AGE_MS) {
    return cached.value;
  }
  const stop = stopByCode(code);
  if (!stop) return null;
  try {
    // Twenty departures cover every route of all but the busiest stops.
    const departures = await stopTimes(code, { count: 20 });
    // A route may call in both directions at a terminus or on a loop: keep
    // every direction, in order of appearance.
    const byRoute = new Map();
    const trips = new Map();
    for (const departure of departures) {
      const headsigns = byRoute.get(departure.route) ?? [];
      if (departure.headsign && !headsigns.includes(departure.headsign)) {
        headsigns.push(departure.headsign);
      }
      byRoute.set(departure.route, headsigns);
      trips.set(departure.tripId, { route: departure.route, headsign: departure.headsign });
    }
    const routes = [...byRoute]
      .map(([route, headsigns]) => ({ route, headsigns }))
      .sort((a, b) => a.route.localeCompare(b.route, 'en', { numeric: true }));
    const value = { code, name: stop.name, routes, trips };
    descriptions.set(code, { at: now, value });
    return value;
  } catch (err) {
    logger.debug(`Stop ${code} could not be described: ${err.message}`);
    return cached?.value ?? null;
  }
}

/** The description already known for a stop, without any request. */
export function knownStop(code) {
  return descriptions.get(code)?.value ?? null;
}

/**
 * "6 → Downtown, 50 → Waterfront": the routes of a stop with their directions.
 * @param {{ routes: { route: string, headsigns: string[] }[] } | null} description
 */
export function formatRoutes(description) {
  return (description?.routes ?? [])
    .map(({ route, headsigns }) =>
      headsigns?.length ? `${route} → ${headsigns.join('/')}` : route,
    )
    .join(', ');
}

/**
 * The upcoming departures of a watched stop from Transitous, in the shape the
 * operator's real-time path produces (src/api/realtime.js `departuresFromFeed`),
 * so the devices, widgets and scenes do not care where the board came from.
 *
 * @param {{ id: string, routes: string[] }} stop
 * @param {{ now?: number }} [options]
 */
export async function scheduledDepartures(stop, { now = Date.now() } = {}) {
  const nowSeconds = Math.floor(now / 1000);
  const departures = await stopTimes(stop.id, { count: 10 });
  return departures
    .filter((departure) => departure.time >= nowSeconds - 30)
    .filter(
      (departure) =>
        stop.routes.length === 0 || stop.routes.includes(normalizeRoute(departure.route)),
    )
    .map((departure) => ({
      route: departure.route,
      headsign: departure.headsign,
      tripId: departure.tripId,
      time: departure.time,
      minutes: Math.max(0, Math.floor((departure.time - nowSeconds) / 60)),
      delaySeconds: departure.delaySeconds,
      realtime: departure.realtime,
    }));
}
