// -----------------------------------------------------------------------------
// The stop table of the network: every stop code riders know, with its name,
// its position and the GTFS stop_ids behind it (gtfs/stops.json), and the
// route labels (gtfs/routes.json). Both are generated from the operator's
// static GTFS by `npm run update-stops` (see scripts/update-stops.mjs for why
// the table ships with the image).
//
// It answers, without any request:
//   - which stops are near this house          (stopsNear);
//   - which stops match "Granville Station"     (searchStops);
//   - which stop_ids the real-time feed uses for the code on the sign
//                                                (stopByCode);
//   - what route a route_id of a feed is         (routeLabel).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const DATA_DIR = new URL('../../gtfs/', import.meta.url);

/**
 * `scheduleOnly`: the operator's real-time feed leaves the stop out (the TTC
 * publishes no prediction for its subway): its departures are the timetable.
 * @typedef {{ code: string, name: string, lat: number, lon: number,
 *   ids: string[], query: string[], scheduleOnly: boolean }} Stop
 */

/** @type {{ stops: Stop[], byCode: Map<string, Stop>, generated: string } | null} */
let table = null;
/** @type {Record<string, string> | null} */
let routes = null;

/** The stop table, read on first use (750 KB of JSON: not at import time). */
function loadStops() {
  if (!table) {
    const raw = JSON.parse(readFileSync(new URL('stops.json', DATA_DIR), 'utf8'));
    const stops = raw.stops.map(([code, name, lat, lon, ids, query, scheduleOnly]) => ({
      code,
      name,
      lat,
      lon,
      ids,
      query,
      scheduleOnly: scheduleOnly === 1,
    }));
    table = {
      stops,
      byCode: new Map(stops.map((stop) => [stop.code, stop])),
      generated: raw.generated,
    };
  }
  return table;
}

function loadRoutes() {
  if (!routes) {
    routes = JSON.parse(readFileSync(new URL('routes.json', DATA_DIR), 'utf8')).routes;
  }
  return routes;
}

/** The date the stop table was generated, for the logs and the docs. */
export function stopTableDate() {
  return loadStops().generated;
}

/**
 * The stop behind a code, or null when the table does not know it (a typo, or
 * a stop opened after the table was generated).
 * @param {string} code
 * @returns {Stop | null}
 */
export function stopByCode(code) {
  return loadStops().byCode.get(String(code).trim()) ?? null;
}

/**
 * The label of a GTFS route_id ("6637" → "50", "13686" → "Canada Line"), or
 * null when the table does not know it.
 * @param {string | undefined} routeId
 */
export function routeLabel(routeId) {
  if (routeId === undefined || routeId === null) return null;
  return loadRoutes()[String(routeId)] ?? null;
}

/**
 * A route as a filter compares it: upper case, without the leading zeros
 * some operators publish ("099" is the 99).
 * @param {string} route
 */
export function normalizeRoute(route) {
  return String(route ?? '')
    .trim()
    .replace(/^0+(?=.)/, '')
    .toUpperCase();
}

/**
 * Distance in meters between two points (haversine): enough precision to sort
 * the stops of a neighborhood.
 */
export function distanceMeters(a, b) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.asin(Math.sqrt(h)));
}

/**
 * The stops within `radiusMeters` of a point, closest first.
 * @param {{ lat: number, lon: number }} point
 * @param {number} radiusMeters
 * @returns {(Stop & { distance: number })[]}
 */
export function stopsNear(point, radiusMeters) {
  // A cheap box first: a degree of latitude is 111 km everywhere.
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((point.lat * Math.PI) / 180));
  return loadStops()
    .stops.filter(
      (stop) => Math.abs(stop.lat - point.lat) <= dLat && Math.abs(stop.lon - point.lon) <= dLon,
    )
    .map((stop) => ({ ...stop, distance: distanceMeters(point, stop) }))
    .filter((stop) => stop.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}

/** Lower case, without accents nor punctuation: "Côte-des-Neiges" matches "cote des neiges". */
export function fold(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .toLowerCase()
    .trim();
}

/**
 * The stops whose name holds every word of the query, or whose code is the
 * query: "granville station", "50040", "davie bidwell".
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {Stop[]}
 */
export function searchStops(query, { limit = 8 } = {}) {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const exact = stopByCode(query);
  const folded = words.join(' ');
  // The best answers first: the stop named exactly so ("Rideau", the
  // station), then the names that start with the query, then the others.
  const rank = (stop) => {
    const name = fold(stop.name);
    if (name === folded) return 0;
    return name.startsWith(folded) ? 1 : 2;
  };
  const matches = loadStops()
    .stops.filter((stop) => {
      if (stop === exact) return false;
      const name = ` ${fold(stop.name)} `;
      return words.every((word) => name.includes(` ${word}`));
    })
    .map((stop) => ({ stop, rank: rank(stop) }))
    .sort((a, b) => a.rank - b.rank || a.stop.name.localeCompare(b.stop.name, 'fr'))
    .map(({ stop }) => stop);
  return [...(exact ? [exact] : []), ...matches].slice(0, limit);
}
