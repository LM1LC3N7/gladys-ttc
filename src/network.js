// -----------------------------------------------------------------------------
// The transit network this integration serves: the TTC, Toronto.
//
// Everything that names the operator, its feeds or its lines lives here, so
// the rest of the code reads "the network", "the bike share", "the lines" —
// and the sister integrations (TransLink, OC Transpo, RTC Québec) differ from
// this one by this file, their gtfs/ folder and their texts, not by their
// logic.
// -----------------------------------------------------------------------------

import { ALERT_EFFECT, ALERT_SEVERITY } from './api/gtfsRealtime.js';

/** The rapid transit routes: the subway lines 1, 2 and 4, the LRT lines 5 and 6. */
const RAPID_TRANSIT_ROUTES = ['1', '2', '4', '5', '6'];

// The effects of the TTC alerts API, by their GTFS-Realtime name.
const EFFECTS = new Map(Object.entries(ALERT_EFFECT));

/**
 * The TTC live alerts (the JSON behind ttc.ca's service advisories) in the
 * shape of a decoded GTFS-Realtime alerts feed, which src/api/lines.js reads.
 *
 * The TTC's GTFS-Realtime alerts feed cannot make a line status: a subway
 * closure there names the shuttle bus routes, not the subway line, and every
 * alert has an unknown effect. The JSON names the line, the effect and the
 * severity. Two of its conventions are translated here:
 *   - a "Minor" alert is a standing slow zone ("trains will move slower than
 *     usual between…"): a notice, not a disruption, or Line 1 would never be
 *     normal;
 *   - an alert with child alerts announces them ("On Monday, service will
 *     start by 11 a.m."): the announcement is a notice, the child alert is
 *     listed on its own once it applies.
 *
 * @param {any} json the answer of `lineAlerts.url`
 * @returns {{ timestamp: number | undefined, alerts: object[] }}
 */
export function parseTtcAlerts(json) {
  const seconds = (iso) => {
    const time = Date.parse(iso ?? '');
    // The API writes "0001-01-01T00:00:00Z" for "no end".
    return Number.isFinite(time) && time > 0 ? Math.floor(time / 1000) : undefined;
  };
  const alerts = (Array.isArray(json?.routes) ? json.routes : []).map((alert) => {
    const announcement = Array.isArray(alert?.childAlerts) && alert.childAlerts.length > 0;
    const minor = String(alert?.severity ?? '').toLowerCase() === 'minor';
    const effect =
      announcement || minor
        ? ALERT_EFFECT.OTHER_EFFECT
        : (EFFECTS.get(String(alert?.effect ?? '')) ?? ALERT_EFFECT.UNKNOWN_EFFECT);
    return {
      id: String(alert?.id ?? ''),
      activePeriods: [
        { start: seconds(alert?.activePeriod?.start), end: seconds(alert?.activePeriod?.end) },
      ],
      informedEntities: String(alert?.route ?? '')
        .split(',')
        .map((route) => route.trim())
        .filter(Boolean)
        .map((routeId) => ({ routeId })),
      effect,
      severity:
        String(alert?.severity ?? '').toLowerCase() === 'critical' && !announcement
          ? ALERT_SEVERITY.SEVERE
          : ALERT_SEVERITY.INFO,
      headerText: [{ text: String(alert?.headerText || alert?.title || ''), language: 'en' }],
    };
  });
  return { timestamp: seconds(json?.lastUpdated), alerts };
}

// The attributes of one XML element: `name="value"` pairs.
const attributes = (text) =>
  Object.fromEntries(
    [...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  );

// The five entities XML escapes; NextBus titles carry "&amp;".
const unescapeXml = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * The NextBus predictions of one stop in the shape of decoded GTFS-Realtime
 * stop time updates, which src/api/realtime.js reads.
 *
 * The answer lists, per route (`routeTag`, the GTFS route_id), per direction
 * (its title is the GTFS headsign), the coming vehicles: `epochTime` in
 * milliseconds and `tripTag`, the GTFS trip_id. A stop the API does not know
 * answers an <Error>: no departure. No dependency for a flat document of
 * three element types: the elements are read with regular expressions.
 *
 * @param {string} xml
 * @param {string} code the stop code asked for, which stands for the stop_id
 * @returns {{ timestamp: undefined, stopTimes: object[] }}
 */
export function parseNextBusPredictions(xml, code) {
  const stopTimes = [];
  const text = String(xml ?? '');
  for (const block of text.matchAll(/<predictions\b([^>]*)>([\s\S]*?)<\/predictions>/g)) {
    const { routeTag } = attributes(block[1]);
    for (const direction of block[2].matchAll(/<direction\b([^>]*)>([\s\S]*?)<\/direction>/g)) {
      const headsign = unescapeXml(attributes(direction[1]).title ?? '');
      for (const prediction of direction[2].matchAll(/<prediction\b([^>]*)\/>/g)) {
        const { epochTime, tripTag, isDeparture } = attributes(prediction[1]);
        const time = Math.floor(Number(epochTime) / 1000);
        if (!Number.isFinite(time) || time <= 0) continue;
        const event = { time };
        stopTimes.push({
          stopId: String(code),
          routeId: routeTag,
          tripId: tripTag,
          headsign,
          tripScheduleRelationship: 0,
          scheduleRelationship: 0,
          ...(isDeparture === 'true' ? { departure: event } : { arrival: event }),
        });
      }
    }
  }
  return { timestamp: undefined, stopTimes };
}

export const NETWORK = {
  /** The operator, as riders call it. */
  operator: 'TTC',
  /** The device names start with it: "TTC – Bay St at Front St West - Union Station". */
  stopPrefix: 'TTC – ',
  /** The language of the texts when the user did not choose one. */
  defaultLanguage: 'en',

  /**
   * The static GTFS the stop table (gtfs/stops.json, gtfs/routes.json) is
   * generated from, by `npm run update-stops` (City of Toronto open data).
   */
  gtfs: {
    url: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip',
    stopName: (row) => row.stop_name,
    // The real-time feed carries the buses and the streetcars only: the
    // platforms of these routes read the timetable (see scheduleOnly in
    // src/api/stops.js).
    scheduleOnlyRoutes: RAPID_TRANSIT_ROUTES,
  },

  /** Transitous ids are the GTFS ids behind this prefix: `ca-on-TTC_247`. */
  transitousPrefix: 'ca-on-TTC_',

  /**
   * The TTC real time, open: no key, no account.
   *
   * The TTC GTFS-Realtime feed (bustime.ttc.ca/gtfsrt) cannot be used: its
   * stop ids are numbered apart from the static GTFS (checked in 2026-10: 165
   * of 13,650 stop times named a stop its route serves). The NextBus API
   * (umoiq.com), which the TTC still feeds, speaks the numbers on the signs
   * and the trip ids of the static GTFS: it is read stop by stop
   * (`stopFeed`). It has the buses and the streetcars, not the subway nor the
   * LRT (see gtfs.scheduleOnlyRoutes).
   */
  realtime: {
    keyless: true,
    keyLabel: null,
    portal: 'https://www.ttc.ca/transparency-and-accountability/Open-Data',
    tripUpdatesUrl: null,
    stopFeed: {
      url: (code) =>
        `https://webservices.umoiq.com/service/publicXMLFeed?command=predictions&a=ttc&stopId=${encodeURIComponent(code)}`,
      parse: parseNextBusPredictions,
    },
    alertsUrl: null,
    /** The line status comes from the TTC live alerts (see parseTtcAlerts). */
    lineAlerts: { url: 'https://alerts.ttc.ca/api/alerts/live-alerts', parse: parseTtcAlerts },
    /**
     * The request of one feed: nothing to add.
     * @param {string} url
     */
    authorize: (url) => ({ url, headers: {} }),
  },

  /**
   * The rapid transit lines whose alerts make the "lines" device. `routeIds`
   * are the GTFS route_id values of gtfs/routes.json. The `id` keys are
   * forever: Gladys keys the features, the history and the scenes on them.
   */
  lines: [
    {
      id: 'line1',
      routeIds: ['1'],
      name: { en: 'Line 1 Yonge-University', fr: 'Ligne 1 Yonge-University' },
    },
    {
      id: 'line2',
      routeIds: ['2'],
      name: { en: 'Line 2 Bloor-Danforth', fr: 'Ligne 2 Bloor-Danforth' },
    },
    { id: 'line4', routeIds: ['4'], name: { en: 'Line 4 Sheppard', fr: 'Ligne 4 Sheppard' } },
    { id: 'line5', routeIds: ['5'], name: { en: 'Line 5 Eglinton', fr: 'Ligne 5 Eglinton' } },
    { id: 'line6', routeIds: ['6'], name: { en: 'Line 6 Finch West', fr: 'Ligne 6 Finch West' } },
  ],
  /** "Subway" in the device and widget names. */
  linesName: { en: 'Subway and LRT', fr: 'Métro et SLR' },

  /** The bike share, read from its open GBFS feed. */
  bike: {
    name: 'Bike Share Toronto',
    prefix: 'Bike Share – ',
    gbfsUrl: 'https://toronto.publicbikesystem.net/customer/gbfs/v2/gbfs.json',
  },

  /** The search example of the "Find a stop" answers: a network landmark. */
  examples: { search: 'Union Station' },
};
