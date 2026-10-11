// -----------------------------------------------------------------------------
// Transitous client: departures of a stop code, route labels, descriptions.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearTransitousCache,
  describeStop,
  formatRoutes,
  gtfsId,
  knownStop,
  scheduledDepartures,
  stopTimes,
  tidyHeadsign,
  TransitousError,
} from '../src/api/transitous.js';
import { distanceMeters } from '../src/api/stops.js';
import { stopTimesPayload } from './helpers/fixtures.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';

const HOME = { lat: 43.6455, lon: -79.3797 };
const NOW = Date.UTC(2026, 9, 11, 16, 0, 0);

beforeEach(() => clearTransitousCache());
afterEach(() => restoreFetch());

test('Transitous ids give back the GTFS ids', () => {
  assert.equal(gtfsId('ca-on-TTC_247'), '247');
  assert.equal(gtfsId('20261011_08:46_ca-on-TTC_50862843'), '50862843');
  assert.equal(gtfsId(undefined), '');
});

test('a stop code is asked by its GTFS id, with a User-Agent', async () => {
  const calls = stubFetch({ '/v5/stoptimes': stopTimesPayload(NOW, [{ minutes: 3 }]) });
  await stopTimes('247');
  assert.match(calls[0].url, /stopId=ca-on-TTC_247&n=10/);
  assert.match(calls[0].headers['User-Agent'], /^gladys-ttc\/.*github\.com/);
  await assert.rejects(stopTimes('00000'), TransitousError);
});

test('the departures: route labels from the table, other bays and termini dropped', async () => {
  stubFetch({
    '/v5/stoptimes': stopTimesPayload(NOW, [
      { minutes: 3 },
      {
        minutes: 7,
        routeId: '202',
        shortName: '202',
        headsign: 'South - 202 Cherry Beach towards Cherry Beach',
        delayMinutes: 2,
      },
      // Transitous answers for the whole station group: the other side of
      // Bay St is another sign.
      { minutes: 8, stopId: '246' },
      { minutes: 9, cancelled: true },
      { minutes: 10, pickupType: 'NOT_ALLOWED' },
      // A route the table does not know: the short name, without its zeros.
      { minutes: 11, routeId: 'new', shortName: '0R5', headsign: 'Hastings', realTime: true },
    ]),
  });
  const departures = await stopTimes('247');
  assert.deepEqual(
    departures.map(({ route, headsign, delaySeconds, realtime }) => [
      route,
      headsign,
      delaySeconds,
      realtime,
    ]),
    [
      ['114', 'Carlaw', 0, false],
      ['202', 'Cherry Beach', 120, false],
      ['R5', 'Hastings', 0, true],
    ],
  );
});

test('headsigns lose the route they repeat', () => {
  assert.equal(tidyHeadsign('3 Main/To Marine Dr Station', '3'), 'Main/To Marine Dr Station');
  assert.equal(tidyHeadsign('Canada Line To YVR-Airport', 'Canada Line'), 'YVR-Airport');
  assert.equal(tidyHeadsign('UBC', '99'), 'UBC');
  assert.equal(tidyHeadsign('99', '99'), '99');
  assert.equal(tidyHeadsign('Hospital ~ Hôpital', '45'), 'Hospital / Hôpital');
  // The TTC: the destination follows "towards".
  assert.equal(tidyHeadsign('East - 114 Queens Quay East towards Carlaw', '114'), 'Carlaw');
  assert.equal(
    tidyHeadsign('Line 1 (Yonge-University) towards Finch Station', '1'),
    'Finch Station',
  );
});

test('scheduled departures have the shape of the real-time board', async () => {
  stubFetch({
    '/v5/stoptimes': stopTimesPayload(NOW, [
      { minutes: -5 },
      {
        minutes: 4,
        routeId: '202',
        shortName: '202',
        headsign: 'South - 202 Cherry Beach towards Cherry Beach',
      },
      { minutes: 2 },
    ]),
  });
  const board = await scheduledDepartures({ id: '247', routes: [] }, { now: NOW });
  assert.deepEqual(
    board.map(({ route, minutes, realtime, headsign }) => [route, minutes, realtime, headsign]),
    [
      ['114', 2, false, 'Carlaw'],
      ['202', 4, false, 'Cherry Beach'],
    ],
  );
  const filtered = await scheduledDepartures({ id: '247', routes: ['202'] }, { now: NOW });
  assert.deepEqual(
    filtered.map((departure) => departure.route),
    ['202'],
  );
});

test('a stop description is cached for a day, and survives a failed refresh', async () => {
  const calls = stubFetch({
    '/v5/stoptimes': stopTimesPayload(NOW, [
      {
        minutes: 1,
        routeId: '202',
        shortName: '202',
        headsign: 'South - 202 Cherry Beach towards Cherry Beach',
      },
      { minutes: 2 },
      { minutes: 3 },
    ]),
  });
  const description = await describeStop('247', { now: NOW });
  assert.equal(formatRoutes(description), '114 → Carlaw, 202 → Cherry Beach');
  assert.equal(description.name, 'Bay St at Front St West - Union Station');
  // The trips seen at the stop name the route of a bare real-time prediction.
  assert.deepEqual(description.trips.get('T0'), { route: '202', headsign: 'Cherry Beach' });
  await describeStop('247', { now: NOW + 3_600_000 });
  assert.equal(calls.length, 1);
  assert.equal(knownStop('247'), description);

  restoreFetch();
  stubFetch({ '/v5/stoptimes': { status: 503, body: 'down' } });
  const stale = await describeStop('247', { now: NOW + 2 * 86_400_000 });
  assert.equal(stale, description);
  assert.equal(await describeStop('00000', { now: NOW }), null);
});

test('a route serving both directions lists both', async () => {
  stubFetch({
    '/v5/stoptimes': stopTimesPayload(NOW, [
      { minutes: 1, headsign: 'West' },
      { minutes: 2, headsign: 'East' },
      { minutes: 3, headsign: 'West' },
    ]),
  });
  assert.equal(formatRoutes(await describeStop('247', { now: NOW })), '114 → West/East');
});

test('distances', () => {
  assert.equal(distanceMeters(HOME, HOME), 0);
  const oneKmNorth = { lat: HOME.lat + 1 / 111.2, lon: HOME.lon };
  assert.ok(Math.abs(distanceMeters(HOME, oneKmNorth) - 1000) < 5);
});
