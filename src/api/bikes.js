// -----------------------------------------------------------------------------
// The bike share (NETWORK.bike): its open GBFS feed (no account, no key).
//
// GBFS splits a bike-share system into files listed by a discovery document
// (`gbfs.json`): the stations themselves (`station_information`: name,
// capacity — changes rarely) and their live counts (`station_status`: bikes,
// e-bikes, free docks — refreshed by the operator every few seconds). Both are
// a few hundred kilobytes for the whole network, so each is read once per
// cycle and shared by every watched station, and the station list is kept for
// an hour.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { request } from './http.js';
import { NETWORK } from '../network.js';

const logger = createLogger({ name: 'bikes' });

export const GBFS_URL = NETWORK.bike?.gbfsUrl;
const BIKE_SHARE = NETWORK.bike?.name ?? 'bike share';

// The station list (names, capacities) changes when a station is added for
// the season; an hour is fresh enough and spares a 400 KB download a minute.
const INFORMATION_MAX_AGE_MS = 60 * 60_000;

/** Error of the bike share feed. */
export class BikeShareError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BikeShareError';
  }
}

/** @type {Map<string, { at: number, value: unknown }>} */
const cache = new Map();
/** @type {Map<string, Promise<unknown>>} */
const inFlight = new Map();

/**
 * The name of a station from the station list already read, without any
 * request: the device name uses it when the user gave none.
 * @param {string} id
 * @returns {string | null}
 */
export function knownStationName(id) {
  const stations = cache.get('station_information')?.value?.data?.stations;
  const station = Array.isArray(stations)
    ? stations.find((candidate) => String(candidate?.station_id) === String(id))
    : undefined;
  return station?.name ? String(station.name) : null;
}

/** Forget every cached file (configuration change, tests). */
export function clearBikeCache() {
  cache.clear();
  inFlight.clear();
}

/**
 * A cached read: the value when younger than `maxAgeMs`, else the read in
 * flight, else a new read.
 * @param {string} key
 * @param {number} maxAgeMs
 * @param {() => Promise<unknown>} read
 * @param {number} now
 */
function cached(key, maxAgeMs, read, now) {
  const hit = cache.get(key);
  if (hit && now - hit.at < maxAgeMs) {
    return Promise.resolve(hit.value);
  }
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }
  const promise = read()
    .then((value) => {
      cache.set(key, { at: now, value });
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });
  inFlight.set(key, promise);
  return promise;
}

async function getJson(url) {
  const response = await request(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new BikeShareError(
      `${BIKE_SHARE} GBFS ${url.split('?')[0]} answered HTTP ${response.status}`,
    );
  }
  return response.json();
}

/**
 * The URL of one GBFS file, from the discovery document. GBFS 2.x lists the
 * files per language (`data.fr.feeds`, `data.en.feeds`); the integration's
 * language is preferred, any other one will do — the files are the same.
 *
 * @param {object} discovery the parsed gbfs.json
 * @param {string} name e.g. 'station_status'
 * @param {string} language
 * @returns {string}
 */
export function feedUrl(discovery, name, language) {
  const data = discovery?.data ?? {};
  const languages = [language, ...Object.keys(data).filter((key) => key !== language)];
  for (const lang of languages) {
    const feed = data[lang]?.feeds?.find((candidate) => candidate?.name === name);
    if (feed?.url) {
      return feed.url;
    }
  }
  throw new BikeShareError(`The ${BIKE_SHARE} GBFS discovery document lists no "${name}" file`);
}

/**
 * Every station of the network, with its live counts.
 *
 * @param {{ bike_poll_frequency: number, language: string }} config
 * @param {{ now?: number }} [options]
 * @returns {Promise<Map<string, {
 *   id: string, name: string, capacity?: number, bikes?: number,
 *   electricBikes?: number, docks?: number, installed: boolean,
 *   renting: boolean, returning: boolean, lastReported?: number }>>}
 */
export async function fetchStations(config, { now = Date.now() } = {}) {
  const discovery = await cached('discovery', INFORMATION_MAX_AGE_MS, () => getJson(GBFS_URL), now);
  const [information, status, vehicleTypes] = await Promise.all([
    cached(
      'station_information',
      INFORMATION_MAX_AGE_MS,
      () => getJson(feedUrl(discovery, 'station_information', config.language)),
      now,
    ),
    cached(
      'station_status',
      config.bike_poll_frequency * 1000 * 0.9,
      () => getJson(feedUrl(discovery, 'station_status', config.language)),
      now,
    ),
    // Optional in GBFS 2.x: without it, a feed that does not count its
    // e-bikes itself has no e-bike count.
    cached(
      'vehicle_types',
      INFORMATION_MAX_AGE_MS,
      () => getJson(feedUrl(discovery, 'vehicle_types', config.language)).catch(() => null),
      now,
    ),
  ]);
  return mergeStations(information, status, vehicleTypes);
}

const count = (value) =>
  Number.isFinite(Number(value)) && value !== null ? Number(value) : undefined;
// GBFS 2.x booleans are true booleans, GBFS 1.x ones are 0/1: accept both.
const flag = (value, fallback) =>
  value === undefined || value === null ? fallback : Boolean(Number(value));

/**
 * The e-bikes of a station: the count the feed gives (`num_ebikes_available`,
 * the PBSC systems), else the sum of the vehicle types that
 * are electric (`vehicle_types_available`, GBFS 2.1+, how Mobi counts).
 *
 * @param {object} live an entry of station_status
 * @param {Set<string>} electricTypes vehicle_type_id values with an electric motor
 */
export function electricBikesOf(live, electricTypes) {
  const direct = count(live?.num_ebikes_available);
  if (direct !== undefined) return direct;
  const types = Array.isArray(live?.vehicle_types_available) ? live.vehicle_types_available : [];
  if (types.length === 0 || electricTypes.size === 0) return undefined;
  return types
    .filter((type) => electricTypes.has(String(type?.vehicle_type_id)))
    .reduce((sum, type) => sum + (count(type?.count) ?? 0), 0);
}

/**
 * Join the station list with the live counts, by station_id.
 *
 * @param {object} information parsed station_information.json
 * @param {object} status parsed station_status.json
 * @param {object | null} [vehicleTypes] parsed vehicle_types.json
 */
export function mergeStations(information, status, vehicleTypes = null) {
  const electricTypes = new Set(
    (vehicleTypes?.data?.vehicle_types ?? [])
      .filter((type) => String(type?.propulsion_type ?? '').startsWith('electric'))
      .map((type) => String(type.vehicle_type_id)),
  );
  const stations = new Map();
  for (const station of information?.data?.stations ?? []) {
    if (station?.station_id === undefined) continue;
    const id = String(station.station_id);
    stations.set(id, {
      id,
      name: String(station.name ?? id),
      capacity: count(station.capacity),
      lat: count(station.lat),
      lon: count(station.lon),
    });
  }
  for (const live of status?.data?.stations ?? []) {
    if (live?.station_id === undefined) continue;
    const id = String(live.station_id);
    const station = stations.get(id) ?? { id, name: id };
    // `num_ebikes_available` is part of the bikes count in GBFS: the e-bikes
    // are a subset, not an addition.
    stations.set(id, {
      ...station,
      bikes: count(live.num_bikes_available),
      electricBikes: electricBikesOf(live, electricTypes),
      docks: count(live.num_docks_available),
      installed: flag(live.is_installed, true),
      renting: flag(live.is_renting, true),
      returning: flag(live.is_returning, true),
      lastReported: count(live.last_reported),
    });
  }
  logger.debug(`${BIKE_SHARE}: ${stations.size} station(s) read`);
  return stations;
}

/**
 * One watched station.
 *
 * @param {{ bike_poll_frequency: number, language: string }} config
 * @param {{ id: string }} station
 * @param {{ now?: number }} [options]
 */
export async function fetchStation(config, station, options) {
  const stations = await fetchStations(config, options);
  const found = stations.get(station.id);
  if (found) {
    return found;
  }
  if (stations.size === 0) {
    // An empty network is a broken feed, not every station removed at once.
    throw new BikeShareError(`The ${BIKE_SHARE} network feed lists no station`);
  }
  // A station missing from a feed that lists the others is a station the
  // operator took away: for the winter, for roadworks, or for good. That is a state of the station, not a failed
  // read: it holds no bike and no free dock, and it says why.
  return absentStation(station.id);
}

/**
 * What a station missing from the network feed is: nothing to rent, nothing to
 * return, and flagged `absent` so that the device, the widget and the scene
 * triggers can say "removed" rather than "out of service".
 * @param {string} id
 */
export function absentStation(id) {
  return {
    id,
    name: knownStationName(id) ?? id,
    bikes: 0,
    electricBikes: 0,
    docks: 0,
    installed: false,
    renting: false,
    returning: false,
    absent: true,
  };
}

/**
 * Stations whose name contains the query (case and accents ignored), for the
 * search action of the configuration screen.
 *
 * @param {{ bike_poll_frequency: number, language: string }} config
 * @param {string} query
 * @param {{ limit?: number, now?: number }} [options]
 */
export async function searchStations(config, query, { limit = 15, now } = {}) {
  const needle = fold(query);
  const stations = await fetchStations(config, { now });
  return [...stations.values()]
    .filter((station) => fold(station.name).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .slice(0, limit);
}

/** Lower case, without accents: "Côte-des-Neiges" matches "cote des neiges". */
export function fold(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[-'’]/g, ' ')
    .toLowerCase()
    .trim();
}
