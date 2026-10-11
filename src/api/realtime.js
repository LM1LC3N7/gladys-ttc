// -----------------------------------------------------------------------------
// The operator's real-time feeds (GTFS-Realtime), read with the user's key —
// or without one when the operator publishes them in the open.
//
// Two consequences of how they are served shape this module:
//
//   - the predictions come as ONE TripUpdates feed covering the whole network:
//     it is read once per refresh interval, decoded for every watched stop at
//     once, and each stop takes its share from that cache. Watching ten stops
//     costs exactly what watching one does. An operator answering stop by
//     stop instead (the TTC's NextBus, `NETWORK.realtime.stopFeed`) is read
//     once per interval and stop, translated to the same stop time updates;
//   - a bad key, a quota and a rate limit come back as HTTP errors: they are
//     turned into a bilingual message the user can act on
//     (`RealtimeApiError`), rather than a bare "HTTP 403".
//
// The key may travel in the URL (TransLink): no URL is ever logged whole.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { request } from './http.js';
import {
  GtfsRealtimeDecodeError,
  decodeTripUpdates,
  STOP_SCHEDULE_RELATIONSHIP,
  TRIP_SCHEDULE_RELATIONSHIP,
} from './gtfsRealtime.js';
import { stopPlatformId } from '../config.js';
import { NETWORK } from '../network.js';
import { normalizeRoute, routeLabel, stopByCode } from './stops.js';
import { knownStop, tidyHeadsign } from './transitous.js';

const logger = createLogger({ name: 'realtime' });

// A prediction this far in the past is a vehicle that has left: the feed keeps
// a stop time update for a short while after the vehicle served the stop.
const DEPARTED_GRACE_SECONDS = 30;

// A feed whose header is older than this is not real-time any more: the
// operator's side has stalled. It is still served (it is the best information
// there is), but the logs say so once.
const STALE_FEED_SECONDS = 10 * 60;

// A network without a real-time feed (RTC Québec) never reads one: the label
// only has to exist.
const KEY = NETWORK.realtime?.keyLabel ?? { en: 'API key', fr: 'clé d’API' };

/** Error of the operator's API, with the explanation the user can act on. */
export class RealtimeApiError extends Error {
  /**
   * @param {string} message technical message, for the logs
   * @param {{ status?: number, userMessage?: { en: string, fr: string } }} [details]
   */
  constructor(message, { status, userMessage } = {}) {
    super(message);
    this.name = 'RealtimeApiError';
    this.status = status;
    this.userMessage = userMessage;
  }
}

export const MISSING_KEY_MESSAGE = {
  en: `No ${KEY.en}: create one on the ${NETWORK.operator} developer portal and paste it in the configuration.`,
  fr: `Aucune ${KEY.fr} : créez-en une sur le portail développeurs de ${NETWORK.operator} et collez-la dans la configuration.`,
};

/**
 * Turn a refused request into a RealtimeApiError carrying what to do about it.
 * The body is matched loosely and never echoed whole: it is the operator's,
 * not ours.
 *
 * @param {number} status
 * @param {string} body
 * @param {string} feed the feed name, for the logs
 * @returns {RealtimeApiError}
 */
export function realtimeErrorFor(status, body, feed) {
  const text = String(body ?? '').toLowerCase();
  const message = `${NETWORK.operator} ${feed} feed answered HTTP ${status}`;
  // An open feed has no key to refuse nor quota to exhaust: a refusal there
  // is the operator's side failing, which the next refresh may not see.
  const keyed = !NETWORK.realtime?.keyless;
  if (keyed && text.includes('quota')) {
    return new RealtimeApiError(`${message} (quota)`, {
      status,
      userMessage: {
        en: `The quota of your ${KEY.en} is used up. Raise the refresh intervals.`,
        fr: `Le quota de votre ${KEY.fr} est épuisé. Augmentez les intervalles de rafraîchissement.`,
      },
    });
  }
  if (status === 429) {
    return new RealtimeApiError(`${message} (rate limited)`, {
      status,
      userMessage: {
        en: `${NETWORK.operator} is rate limiting requests right now: the next refresh will try again.`,
        fr: `${NETWORK.operator} limite les requêtes en ce moment : le prochain rafraîchissement réessaiera.`,
      },
    });
  }
  if (keyed && (status === 401 || status === 403 || text.includes('key'))) {
    return new RealtimeApiError(`${message} (key refused)`, {
      status,
      userMessage: {
        en: `${NETWORK.operator} refused the API key: check it on the developer portal (${NETWORK.realtime?.portal}).`,
        fr: `${NETWORK.operator} a refusé la clé d’API : vérifiez-la sur le portail développeurs (${NETWORK.realtime?.portal}).`,
      },
    });
  }
  return new RealtimeApiError(message, { status });
}

/**
 * GET one feed with the user's key (none for an open feed).
 *
 * @param {{ api_key: string }} config
 * @param {string} url
 * @param {string} feed the feed name, for the logs and the errors
 * @param {string} accept the media type asked for
 * @returns {Promise<Response>} an OK response
 */
async function get(config, url, feed, accept) {
  if (!config.api_key && !NETWORK.realtime.keyless) {
    throw new RealtimeApiError('No API key configured', { userMessage: MISSING_KEY_MESSAGE });
  }
  const authorized = NETWORK.realtime.authorize(url, config.api_key);
  let response;
  try {
    response = await request(authorized.url, {
      headers: { ...authorized.headers, Accept: accept },
    });
  } catch (err) {
    // A network error message may quote the URL, and the URL may hold the key.
    throw new RealtimeApiError(
      `${NETWORK.operator} ${feed} feed unreachable: ${redact(err.message, config.api_key)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw realtimeErrorFor(response.status, body, feed);
  }
  return response;
}

/**
 * GET one GTFS-Realtime feed, as bytes.
 *
 * @param {{ api_key: string }} config
 * @param {string} url
 * @param {string} feed the feed name, for the logs and the errors
 * @returns {Promise<Uint8Array>}
 */
export async function readFeed(config, url, feed) {
  // ETS answers 406 to a strict application/x-protobuf: its feeds are served
  // as application/protocol-buffer.
  const response = await get(
    config,
    url,
    feed,
    'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.8',
  );
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * GET one text feed of the operator (the NextBus XML).
 *
 * @param {{ api_key: string }} config
 * @param {string} url
 * @param {string} feed the feed name, for the logs and the errors
 * @returns {Promise<string>}
 */
export async function readText(config, url, feed) {
  const response = await get(config, url, feed, 'text/xml');
  return response.text();
}

/**
 * GET one JSON feed of the operator (the TTC live alerts).
 *
 * @param {{ api_key: string }} config
 * @param {string} url
 * @param {string} feed the feed name, for the logs and the errors
 * @returns {Promise<any>}
 */
export async function readJson(config, url, feed) {
  const response = await get(config, url, feed, 'application/json');
  try {
    return await response.json();
  } catch {
    throw new RealtimeApiError(
      `${NETWORK.operator} ${feed} feed answered something else than JSON`,
    );
  }
}

/**
 * A text with the key masked: what may reach the logs.
 * @param {string} text
 * @param {string} key
 */
export function redact(text, key) {
  const value = String(text ?? '');
  return key ? value.split(key).join('***') : value;
}

// --- Departures --------------------------------------------------------------

/**
 * The decoded feed, shared by every stop for one refresh interval.
 * @type {{ at: number, key: string, stopTimes: object[], timestamp?: number } | null}
 */
let feedCache = null;
/** @type {{ key: string, promise: Promise<object> } | null} */
let feedInFlight = null;
let staleFeedReported = false;
let missingRouteReported = false;

/**
 * Every stop the integration polls: the typed ones, but also the suggested
 * ones and the devices created from a suggestion, which the configuration
 * does not list. The decoder keeps the stop time updates of these stops only,
 * so the device registry hands them over (src/devices/index.js).
 * @type {{ id: string }[]}
 */
let polledStops = [];

/** @param {{ id: string }[]} stops every stop the devices poll */
export function setPolledStops(stops) {
  polledStops = stops;
}

/** Forget the cached feed (configuration change, tests). */
export function clearRealtimeCache() {
  stopFeeds.clear();
  feedCache = null;
  feedInFlight = null;
  staleFeedReported = false;
  missingRouteReported = false;
  polledStops = [];
}

/** The GTFS stop_ids of the watched stop codes: what the decoder keeps. */
function watchedStopIds(stops) {
  const ids = new Set();
  for (const stop of stops) {
    for (const id of stopByCode(stop.id)?.ids ?? []) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * How long the last good read of the feed stands in for a feed served cut
 * short or empty. The Calgary open data portal publishes such a file for 30 s
 * to a minute or more, now and then (2026-10), while it rewrites it; the times
 * of the feed are absolute, so a reading of a few minutes still gives the
 * right waits.
 */
export const STALE_FEED_MAX_MS = 5 * 60_000;

/**
 * Read and decode the network feed for every watched stop.
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ id: string }[]} stops
 */
async function readTripUpdates(config, stops) {
  const stopIds = watchedStopIds(stops);
  const buffer = await readFeed(config, NETWORK.realtime.tripUpdatesUrl, 'TripUpdates');
  // An empty body decodes as a feed without any trip: every board would go
  // blank.
  if (buffer.length === 0) throw new GtfsRealtimeDecodeError('empty feed');
  const decoded = decodeTripUpdates(buffer, stopIds);
  logger.debug(
    `TripUpdates: ${buffer.length} bytes, ${decoded.stopTimes.length} stop time(s) ` +
      `for ${stopIds.length} watched stop id(s)`,
  );
  return decoded;
}

/**
 * The decoded feed, read at most once per refresh interval whatever the
 * number of stops asking, and once for concurrent askers.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ now?: number, fresh?: boolean, stops?: { id: string }[] }} [options]
 *   `fresh` skips the cache (the connection test must reach the API, not the
 *   last poll); `stops` the stops to decode (every polled one)
 */
export async function getTripUpdates(
  config,
  { now = Date.now(), fresh = false, stops = [...config.watched.stops, ...polledStops] } = {},
) {
  const key = `${config.api_key}\u0000${watchedStopIds(stops).join(',')}`;
  // A tenth of the interval of tolerance, like the poll schedule: the poll of
  // the last stop of a cycle must not trigger a second read of the feed.
  const maxAgeMs = config.departures_poll_frequency * 1000 * 0.9;
  if (!fresh && feedCache && feedCache.key === key && now - feedCache.at < maxAgeMs) {
    return feedCache;
  }
  if (!fresh && feedInFlight && feedInFlight.key === key) {
    return feedInFlight.promise;
  }
  const promise = readTripUpdates(config, stops)
    .then((decoded) => {
      feedCache = { at: now, key, ...decoded };
      return feedCache;
    })
    .catch((err) => {
      const lastGood = feedCache?.key === key ? feedCache : null;
      if (
        err instanceof GtfsRealtimeDecodeError &&
        lastGood &&
        now - lastGood.at < STALE_FEED_MAX_MS
      ) {
        // The cache keeps its age: the next poll reads the feed again.
        logger.debug(`TripUpdates: ${err.message}, the last good read stands in`);
        return lastGood;
      }
      throw err;
    })
    .finally(() => {
      if (feedInFlight?.promise === promise) {
        feedInFlight = null;
      }
    });
  feedInFlight = { key, promise };
  return promise;
}

/**
 * The upcoming departures of one watched stop, soonest first, route filter
 * applied.
 *
 * A departure is a stop time update of the feed for one of the stop's
 * stop_ids, from a trip that is not cancelled, which the vehicle does not
 * skip, and which carries a time. The route comes from the trip's route_id
 * (the stop table names it); a feed that omits it is completed from the trips
 * Transitous saw at the stop, which also give the direction when the feed
 * does not.
 *
 * @param {{ stopTimes: object[] }} feed
 * @param {{ id: string, routes: string[] }} stop
 * @param {number} nowSeconds POSIX time
 * @returns {{ route: string, headsign: string, tripId: string | undefined,
 *   directionId: number | undefined, time: number, minutes: number,
 *   delaySeconds: number | undefined, realtime: boolean }[]}
 */
export function departuresFromFeed(feed, stop, nowSeconds) {
  const ids = new Set(stopByCode(stop.id)?.ids ?? []);
  const known = knownStop(stop.id);
  const trips = known?.trips;
  // A trip Transitous has not listed (later than the departures it gave)
  // still has its direction when its route goes one way only at the stop.
  const onlyHeadsign = (route) => {
    const headsigns = known?.routes?.find((entry) => entry.route === route)?.headsigns ?? [];
    return headsigns.length === 1 ? headsigns[0] : '';
  };
  const departures = [];
  for (const stopTime of feed.stopTimes) {
    if (!ids.has(stopTime.stopId)) continue;
    if (stopTime.tripScheduleRelationship === TRIP_SCHEDULE_RELATIONSHIP.CANCELED) continue;
    if (stopTime.scheduleRelationship === STOP_SCHEDULE_RELATIONSHIP.SKIPPED) continue;
    const event = stopTime.departure?.time ? stopTime.departure : stopTime.arrival;
    if (!event?.time) continue;
    if (event.time < nowSeconds - DEPARTED_GRACE_SECONDS) continue;
    const seen = trips?.get(stopTime.tripId);
    const route = routeLabel(stopTime.routeId) ?? seen?.route ?? '';
    if (!route && !missingRouteReported) {
      missingRouteReported = true;
      logger.warn('The real-time feed names no route for some trips: they show without a route.');
    }
    if (stop.routes.length > 0 && !stop.routes.includes(normalizeRoute(route))) continue;
    // A trip on a detour may come twice (ETS): as itself, and as the trip
    // modified, without a route. One departure, the one naming its route.
    const twin = departures.find(
      (departure) => stopTime.tripId && departure.tripId === stopTime.tripId,
    );
    if (twin) {
      if (!twin.route && route) twin.route = route;
      continue;
    }
    departures.push({
      route,
      // A feed naming the direction (NextBus) is the freshest word on it.
      headsign: stopTime.headsign
        ? tidyHeadsign(stopTime.headsign, route)
        : seen?.headsign || onlyHeadsign(route),
      tripId: stopTime.tripId,
      directionId: stopTime.directionId,
      time: event.time,
      minutes: Math.max(0, Math.floor((event.time - nowSeconds) / 60)),
      delaySeconds: event.delay,
      realtime: true,
    });
  }
  return departures.sort((a, b) => a.time - b.time);
}

/**
 * The predictions of one stop, for an operator read stop by stop
 * (`NETWORK.realtime.stopFeed`, the TTC's NextBus): at most once per refresh
 * interval and stop, and once for concurrent askers (the poll and a widget).
 * @type {Map<string, { at: number, feed?: object, promise?: Promise<object> }>}
 */
const stopFeeds = new Map();

/**
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ id: string }} stop
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ stopTimes: object[] }>}
 */
export async function getStopFeed(config, stop, { now = Date.now() } = {}) {
  const { stopFeed } = NETWORK.realtime;
  const maxAgeMs = config.departures_poll_frequency * 1000 * 0.9;
  const cached = stopFeeds.get(stop.id);
  if (cached?.feed && now - cached.at < maxAgeMs) return cached.feed;
  if (cached?.promise) return cached.promise;
  const promise = readText(config, stopFeed.url(stop.id), 'Predictions')
    .then((text) => {
      const feed = stopFeed.parse(text, stop.id);
      stopFeeds.set(stop.id, { at: now, feed });
      return feed;
    })
    .catch((err) => {
      stopFeeds.delete(stop.id);
      throw err;
    });
  stopFeeds.set(stop.id, { at: now, promise });
  return promise;
}

/**
 * The upcoming departures of one watched stop (see `departuresFromFeed`).
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ id: string, routes: string[] }} stop
 * @param {{ now?: number, stops?: { id: string }[] }} [options]
 */
export async function fetchDepartures(config, stop, { now = Date.now(), stops } = {}) {
  const feed = NETWORK.realtime.stopFeed
    ? await getStopFeed(config, stop, { now })
    : await getTripUpdates(config, {
        now,
        stops: stops ?? [...config.watched.stops, ...polledStops, stop],
      });
  const nowSeconds = Math.floor(now / 1000);
  if (feed.timestamp && nowSeconds - feed.timestamp > STALE_FEED_SECONDS && !staleFeedReported) {
    staleFeedReported = true;
    logger.warn(
      `The ${NETWORK.operator} feed is ${Math.round((nowSeconds - feed.timestamp) / 60)} minutes ` +
        'old: the predictions may be out of date.',
    );
  }
  const departures = departuresFromFeed(feed, stop, nowSeconds);
  logger.debug(`Stop ${stopPlatformId(stop)}: ${departures.length} departure(s)`);
  return departures;
}
