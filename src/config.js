// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values come from the `config_schema` declared in
// `gladys-assistant-integration.json`: Gladys renders the form, the SDK fetches
// the result (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module owns the defaults, forces the types (a form may send strings)
// and parses the "list of things to watch" fields into the structures the
// device modules consume.
// -----------------------------------------------------------------------------

import { NETWORK } from './network.js';
import { normalizeRoute } from './api/stops.js';

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (test/manifest.test.js enforces it).
export const DEFAULT_CONFIG = {
  // --- Operator developer portal --------------------------------------------
  // One key per user: a key shipped with the integration would be one account
  // shared by every home, rate limited (or revoked) as such.
  api_key: '',

  // --- What to watch --------------------------------------------------------
  // How many of the stops and bike-share stations closest to the house are
  // proposed in the Discovery screen (src/devices/suggestions.js). 0 turns the
  // suggestion off.
  nearby_stops: 3,
  nearby_bike_stations: 2,
  stops: '',
  watch_lines: true,
  bike_stations: '',
  // Without a key, show the departures Transitous knows (the timetable, and
  // the real time where Transitous has it) rather than nothing: the
  // integration works right after install.
  schedule_without_key: true,

  // --- Refresh intervals, in seconds ---------------------------------------
  // Gladys drives the refresh: each device is published with a
  // `poll_frequency` the core scheduler understands (see gladysPollFrequency
  // below — the core only schedules up to one tick a minute), and the ticks
  // that fall inside the configured interval are dropped by the integration.
  //   - departures are countdowns: one read of the whole network feed a
  //     minute serves every watched stop (1,440 requests a day);
  //   - the line status changes a few times a day: every two minutes is
  //     plenty (720 requests a day);
  //   - the bike share is an open feed with no quota, refreshed by the
  //     operator every few seconds.
  departures_poll_frequency: 60,
  lines_poll_frequency: 120,
  bike_poll_frequency: 120,

  // --- Misc -----------------------------------------------------------------
  max_departures: 3,
  language: NETWORK.defaultLanguage,
};

// The scheduled departures come from Transitous, a free community service:
// a timetable does not move, and its usage policy asks to stay light.
export const MIN_SCHEDULE_POLL_FREQUENCY = 120;

// Below 30 s the operator's feed returns the same payload anyway; above one hour a "real-time" sensor
// stops being real-time.
const MIN_POLL_FREQUENCY = 30;
const MAX_POLL_FREQUENCY = 3600;

/** Languages the text features can be published in. */
export const LANGUAGES = ['fr', 'en'];

// The intervals Gladys itself knows how to schedule (`DEVICE_POLL_FREQUENCIES`
// in the core), in MILLISECONDS. Publishing a `poll_frequency` outside this
// list makes the core reject the WHOLE `POST /discovered_device` batch with a
// 400, which leaves the Discovery screen empty.
export const GLADYS_POLL_FREQUENCIES_MS = [1000, 2000, 10000, 15000, 30000, 60000];

/**
 * The interval Gladys is asked to poll a device at, for a configured refresh
 * interval expressed in seconds: the fastest tick that stays under it (60 s
 * for anything above a minute). The extra ticks are dropped by `dueForRead`
 * in src/devices/pollSchedule.js, so the operator still sees one read per
 * configured interval.
 *
 * @param {number} seconds configured refresh interval
 * @returns {number} a value of GLADYS_POLL_FREQUENCIES_MS
 */
export function gladysPollFrequency(seconds) {
  const wanted = Number(seconds) * 1000;
  const supported = GLADYS_POLL_FREQUENCIES_MS.filter((frequency) => frequency <= wanted);
  return supported.length > 0 ? Math.max(...supported) : Math.min(...GLADYS_POLL_FREQUENCIES_MS);
}

/**
 * Clamp a refresh interval to the accepted range, falling back to the default
 * when the form sent something unusable (empty string, NaN...).
 * @param {unknown} value raw value from the config form
 * @param {number} fallback default declared in the manifest
 * @returns {number} a refresh interval in seconds
 */
export function normalizePollFrequency(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(MAX_POLL_FREQUENCY, Math.max(MIN_POLL_FREQUENCY, Math.round(parsed)));
}

/** The most suggestions of one kind: beyond that, the Discovery screen is a list to read. */
export const MAX_NEARBY = 8;

/**
 * A count of suggestions, bounded to 0..MAX_NEARBY.
 * @param {unknown} value
 * @param {number} fallback
 */
function normalizeCount(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(MAX_NEARBY, Math.max(0, parsed)) : fallback;
}

/**
 * A boolean field, which a form may send as a string.
 * @param {unknown} value
 * @param {boolean} fallback
 */
function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Split a user-provided list. Accepts commas, semicolons and newlines so the
 * user can paste a column from a spreadsheet as easily as a one-liner.
 * @param {unknown} raw
 * @returns {string[]} trimmed, non-empty entries
 */
function splitList(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse a watched bus stop.
 *
 * Syntax: `<stop code>[@<route>[|<route>...]][:<custom name>]`
 *   - `50040`                    every route calling at stop 50040
 *   - `50040@99`                 only route 99
 *   - `50040@99|14`              routes 99 and 14
 *   - `50040@99:Bus to work`     only route 99, displayed as "Bus to work"
 *
 * The stop code is the number written on the stop sign (and in the operator's
 * app); src/api/stops.js knows the GTFS stop_ids behind it.
 *
 * @param {string} entry one raw entry of the `stops` field
 * @returns {{ id: string, routes: string[], name: string | null } | null}
 */
export function parseStopEntry(entry) {
  // The custom name is free text and may itself contain '@': cut on ':' first.
  const separatorIndex = entry.indexOf(':');
  const target = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
  const name = separatorIndex === -1 ? null : entry.slice(separatorIndex + 1).trim() || null;

  const [rawId, rawRoutes] = target.split('@');
  const id = rawId.trim();
  if (id.length === 0) {
    return null;
  }

  const routes = (rawRoutes ?? '')
    .split('|')
    .map(normalizeRoute)
    .filter((route) => route.length > 0);

  return { id, routes, name };
}

/**
 * Parse an entry of the bike station list. Syntax: `<station id>[:<custom name>]`.
 * @param {string} entry
 * @returns {{ id: string, name: string | null } | null}
 */
export function parseSimpleEntry(entry) {
  const separatorIndex = entry.indexOf(':');
  const id = (separatorIndex === -1 ? entry : entry.slice(0, separatorIndex)).trim();
  if (id.length === 0) {
    return null;
  }
  const name = separatorIndex === -1 ? null : entry.slice(separatorIndex + 1).trim() || null;
  return { id, name };
}

/**
 * Keep the first entry of each identity: the same stop listed twice with the
 * same filter would be two blueprints publishing to one device.
 * @template T
 * @param {T[]} entries
 * @param {(entry: T) => string} identity
 * @returns {T[]}
 */
function uniqueBy(entries, identity) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = identity(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The identity of a watched stop: its id and its route filter. */
export function stopPlatformId(stop) {
  return stop.routes.length > 0 ? `${stop.id}@${stop.routes.join('|')}` : stop.id;
}

/**
 * Merge the user config with the defaults and pre-parse the watch lists, so
 * the rest of the code never deals with `undefined` nor with raw strings.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    api_key: String(raw.api_key ?? '').trim(),
    watch_lines: normalizeBoolean(raw.watch_lines, DEFAULT_CONFIG.watch_lines),
    schedule_without_key: normalizeBoolean(
      raw.schedule_without_key,
      DEFAULT_CONFIG.schedule_without_key,
    ),
    nearby_stops: normalizeCount(raw.nearby_stops, DEFAULT_CONFIG.nearby_stops),
    nearby_bike_stations: NETWORK.bike
      ? normalizeCount(raw.nearby_bike_stations, DEFAULT_CONFIG.nearby_bike_stations)
      : 0,
    departures_poll_frequency: normalizePollFrequency(
      raw.departures_poll_frequency,
      DEFAULT_CONFIG.departures_poll_frequency,
    ),
    lines_poll_frequency: normalizePollFrequency(
      raw.lines_poll_frequency,
      DEFAULT_CONFIG.lines_poll_frequency,
    ),
    bike_poll_frequency: normalizePollFrequency(
      raw.bike_poll_frequency,
      DEFAULT_CONFIG.bike_poll_frequency,
    ),
    max_departures: Math.min(
      5,
      Math.max(1, Math.round(Number(raw.max_departures ?? DEFAULT_CONFIG.max_departures)) || 1),
    ),
    language: LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_CONFIG.language,
  };

  // Pre-parsed watch lists, consumed by src/devices/index.js.
  config.watched = {
    stops: uniqueBy(splitList(config.stops).map(parseStopEntry).filter(Boolean), stopPlatformId),
    bikeStations: NETWORK.bike
      ? uniqueBy(
          splitList(config.bike_stations).map(parseSimpleEntry).filter(Boolean),
          (station) => station.id,
        )
      : [],
    lines: config.watch_lines && NETWORK.lines.length > 0,
  };

  return config;
}

/**
 * Whether the operator API key is filled in, for an operator that asks for
 * one. The bike share needs none.
 */
export function hasApiKey(config) {
  return (
    NETWORK.realtime !== null && NETWORK.realtime.keyless !== true && config.api_key.length > 0
  );
}

/**
 * Whether the operator's real-time feeds can be read: with the user's key, or
 * without any when the operator publishes them in the open (the TTC).
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function hasRealtime(config) {
  return NETWORK.realtime?.keyless === true || hasApiKey(config);
}

/**
 * Where the departures come from: the operator's real-time feed when it can
 * be read, Transitous otherwise (unless the user turned that off). A stop the
 * feed leaves out (src/api/stops.js, `scheduleOnly`) reads the timetable
 * whatever the source: see `stopSource` in src/devices/stop.js.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {'realtime' | 'schedule' | 'none'}
 */
export function departuresSource(config) {
  if (hasRealtime(config)) {
    return 'realtime';
  }
  // Without a real-time feed (RTC Québec) Transitous is the only source: it
  // cannot be turned off, the manifest does not even offer the setting.
  if (!NETWORK.realtime) {
    return 'schedule';
  }
  return config.schedule_without_key ? 'schedule' : 'none';
}

/** Whether the line status can be read: it comes from the operator's alerts. */
export function linesEnabled(config) {
  return (
    config.watched.lines &&
    hasRealtime(config) &&
    Boolean(NETWORK.realtime?.alertsUrl || NETWORK.realtime?.lineAlerts)
  );
}

/**
 * The number of requests a day the configuration costs the operator's API,
 * for the connection status. `stops` counts the stops actually polled (the
 * suggested and created ones included), not only the typed ones.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {{ stops?: number }} [options]
 */
export function estimatedDailyRequests(config, { stops = config.watched.stops.length } = {}) {
  const day = 86_400;
  let requests = 0;
  // Only a key has a quota to count against.
  if (!hasApiKey(config)) {
    return 0;
  }
  if (stops > 0) {
    // One read of the network feed serves every watched stop.
    requests += Math.ceil(day / config.departures_poll_frequency);
  }
  if (linesEnabled(config)) {
    requests += Math.ceil(day / config.lines_poll_frequency);
  }
  return requests;
}
