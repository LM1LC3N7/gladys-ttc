// -----------------------------------------------------------------------------
// Payloads shared by the suites. The GBFS ones follow the live Bike Share
// Toronto feed (GBFS 2.3, true booleans, e-bikes counted by vehicle type);
// the Transitous ones follow api.transitous.org (trimmed to the fields the
// integration reads); the alerts follow the TTC live alerts API.
//
// Stops are network landmarks of the stop table (gtfs/stops.json), where the
// stop code is the stop_id:
//   247    Bay St at Front St West - Union Station   (routes 114, 202)
//   10935  Union Station, the streetcar platform     (routes 509, 510)
//   13816  Union Station, Line 1 towards Finch        (timetable only)
// -----------------------------------------------------------------------------

import { GBFS_URL } from '../../src/api/bikes.js';
import { NETWORK } from '../../src/network.js';

const feeds = (lang) => [
  { name: 'station_information', url: `https://gbfs.example/${lang}/station_information.json` },
  { name: 'station_status', url: `https://gbfs.example/${lang}/station_status.json` },
  { name: 'vehicle_types', url: `https://gbfs.example/${lang}/vehicle_types.json` },
];

export const DISCOVERY = {
  ttl: 60,
  version: '2.2',
  data: { en: { feeds: feeds('en') }, fr: { feeds: feeds('fr') } },
};

export const INFORMATION = {
  data: {
    stations: [
      // At Union Station, the house of the fake Gladys.
      {
        station_id: '7033',
        name: 'Union Station',
        capacity: 43,
        lat: 43.645609,
        lon: -79.380386,
      },
      // 550 m away: within the 1 km radius.
      {
        station_id: '7168',
        name: 'Queens Quay / Yonge St',
        capacity: 47,
        lat: 43.641646,
        lon: -79.375308,
      },
      // Fort York, 1.5 km away: beyond the radius.
      {
        station_id: '7000',
        name: 'Fort York Blvd / Capreol Ct',
        capacity: 47,
        lat: 43.639707,
        lon: -79.396143,
      },
    ],
  },
};

export const STATUS = {
  data: {
    stations: [
      {
        station_id: '7033',
        num_bikes_available: 8,
        num_docks_available: 12,
        is_installed: true,
        is_renting: true,
        is_returning: false,
        last_reported: 1791644363,
        vehicle_types_available: [
          { vehicle_type_id: 'ICONIC', count: 6 },
          { vehicle_type_id: 'EFIT', count: 2 },
        ],
      },
      { station_id: '7168', num_bikes_available: 0, num_docks_available: 18, is_installed: false },
      { station_id: '7000', num_bikes_available: 4, num_docks_available: 21, is_installed: true },
    ],
  },
};

export const VEHICLE_TYPES = {
  data: {
    vehicle_types: [
      { vehicle_type_id: 'ICONIC', form_factor: 'bicycle', propulsion_type: 'human' },
      { vehicle_type_id: 'EFIT', form_factor: 'bicycle', propulsion_type: 'electric_assist' },
    ],
  },
};

export function bikeRoutes() {
  return {
    [GBFS_URL]: DISCOVERY,
    '/station_information.json': INFORMATION,
    '/station_status.json': STATUS,
    '/vehicle_types.json': VEHICLE_TYPES,
  };
}

// --- Service alerts ------------------------------------------------------------

/** The route_id of a line of NETWORK.lines. */
export const routeOf = (lineId) => NETWORK.lines.find((line) => line.id === lineId).routeIds[0];

/** A TTC live alert about a whole line (the shape of alerts.ttc.ca). */
export function lineAlert(
  lineId,
  text = 'Line 1 Yonge-University: There is no subway service between two stations.',
  extra = {},
) {
  return {
    id: `${lineId}-${text.length}`,
    alertType: 'Planned',
    activePeriod: { start: '2025-10-10T05:00:00Z', end: '0001-01-01T00:00:00Z' },
    route: routeOf(lineId),
    routeType: 'Subway',
    effect: 'NO_SERVICE',
    severity: 'Critical',
    headerText: text,
    childAlerts: [],
    ...extra,
  };
}

/**
 * The TTC live alerts answer, its `status: "success"` left out: the fetch
 * stub reads a `status` key as the HTTP status of the answer.
 */
export function alertsFeed(alerts = [], lastUpdated = '2025-10-10T12:40:00Z') {
  return { total: alerts.length, lastUpdated, routes: alerts, accessibility: [] };
}

// --- NextBus predictions -------------------------------------------------------

/** The path of the NextBus API, what the fetch stub routes on. */
export const PREDICTIONS_PATH = new URL(NETWORK.realtime.stopFeed.url('0')).pathname;

/**
 * The NextBus API answering for the stop asked: each departure is
 * `{ stopId, routeId, tripId, time (POSIX seconds), headsign?, departure? }`.
 * A stop with no departure gets the empty answer of a known stop.
 * @param {object[]} departures
 */
export function predictionsFeed(departures) {
  return (href) => {
    const code = new URL(href).searchParams.get('stopId');
    const byRoute = new Map();
    for (const departure of departures.filter((entry) => entry.stopId === code)) {
      const list = byRoute.get(departure.routeId) ?? [];
      list.push(departure);
      byRoute.set(departure.routeId, list);
    }
    const blocks = [...byRoute].map(([route, list]) => {
      const headsign = list[0].headsign ?? `East - ${route} Main &amp; Front towards Somewhere`;
      const predictions = list
        .map(
          ({ time, tripId, departure }) =>
            `<prediction epochTime="${time * 1000}" seconds="0" minutes="0" ` +
            `isDeparture="${departure ? 'true' : 'false'}" tripTag="${tripId}" />`,
        )
        .join('\n');
      return (
        `<predictions routeTag="${route}" stopTitle="Stop" stopTag="1">\n` +
        `<direction title="${headsign}">\n${predictions}\n</direction>\n</predictions>`
      );
    });
    return `<?xml version="1.0" encoding="utf-8" ?>\n<body copyright="TTC">\n${blocks.join('\n')}\n</body>\n`;
  };
}

// --- Transitous ---------------------------------------------------------------

/**
 * /v5/stoptimes for one stop: departures `minutes` from `now` (ms). The
 * default route is the 114, leaving from stop 247.
 */
export function stopTimesPayload(now, entries) {
  const iso = (ms) => new Date(ms).toISOString();
  const prefix = NETWORK.transitousPrefix;
  return {
    stopTimes: entries.map(
      (
        {
          minutes,
          routeId = '114',
          shortName = '114',
          headsign = 'East - 114 Queens Quay East towards Carlaw',
          stopId = '247',
          delayMinutes = 0,
          cancelled = false,
          realTime = false,
          pickupType = 'NORMAL',
        },
        index,
      ) => ({
        place: {
          name: 'Bay St at Front St West - Union Station',
          stopId: `${prefix}${stopId}`,
          departure: iso(now + (minutes + delayMinutes) * 60_000),
          scheduledDeparture: iso(now + minutes * 60_000),
          pickupType,
        },
        realTime,
        headsign,
        tripId: `20261011_08:46_${prefix}T${index}`,
        routeId: `${prefix}${routeId}`,
        routeShortName: shortName,
        cancelled,
        tripCancelled: false,
      }),
    ),
  };
}
