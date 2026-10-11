// -----------------------------------------------------------------------------
// The operator's real-time client: departures, the per-stop cache, the stop
// table mapping, the refusals. The TTC is read stop by stop from NextBus.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  clearRealtimeCache,
  departuresFromFeed,
  fetchDepartures,
  getStopFeed,
  realtimeErrorFor,
  RealtimeApiError,
  redact,
} from '../src/api/realtime.js';
import { NETWORK, parseNextBusPredictions } from '../src/network.js';
import { PREDICTIONS_PATH, predictionsFeed } from './helpers/fixtures.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';

const NOW_MS = 1_760_100_000_000;
const NOW = NOW_MS / 1000;

// 247 is Bay St at Front St West (routes 114 and 202); 10935 the streetcar
// platform of Union Station (509, 510). The stop code is the stop_id, the
// route_id the route number, the NextBus tripTag the GTFS trip_id.
const config = normalizeConfig({ stops: '247, 247@202, 10935' });

function feed() {
  return predictionsFeed([
    {
      stopId: '247',
      routeId: '114',
      tripId: 'late',
      time: NOW + 600,
      headsign: 'West - 114 Queens Quay East towards Union Station',
    },
    { stopId: '247', routeId: '202', tripId: 'soon', time: NOW + 125 },
    { stopId: '247', routeId: '114', tripId: 'gone', time: NOW - 120 },
    { stopId: '10935', routeId: '509', tripId: 'streetcar', time: NOW + 60, departure: true },
  ]);
}

beforeEach(() => clearRealtimeCache());
afterEach(() => restoreFetch());

test('departures are read per stop, named, sorted and filtered', async () => {
  stubFetch({ [PREDICTIONS_PATH]: feed() });
  const [stop, stopRoute202, streetcar] = config.watched.stops;

  const board = await fetchDepartures(config, stop, { now: NOW_MS });
  assert.deepEqual(
    board.map((departure) => [departure.tripId, departure.route, departure.minutes]),
    [
      ['soon', '202', 2],
      ['late', '114', 10],
    ],
  );
  assert.equal(board[0].realtime, true);
  // The direction NextBus gives, without the route it repeats.
  assert.equal(board[1].headsign, 'Union Station');

  // The route filter keeps the 202 and drops the 114 calling at the same stop.
  const filtered = await fetchDepartures(config, stopRoute202, { now: NOW_MS });
  assert.deepEqual(
    filtered.map((departure) => departure.tripId),
    ['soon'],
  );

  const platform = await fetchDepartures(config, streetcar, { now: NOW_MS });
  assert.deepEqual(
    platform.map((departure) => [departure.route, departure.minutes, departure.headsign]),
    [['509', 1, 'Somewhere']],
  );
});

test('one read per stop and interval, without any key', async () => {
  const calls = stubFetch({ [PREDICTIONS_PATH]: feed() });
  const [stop, stopRoute202, streetcar] = config.watched.stops;
  await fetchDepartures(config, stop, { now: NOW_MS });
  // The same stop with another route filter is the same NextBus answer.
  await fetchDepartures(config, stopRoute202, { now: NOW_MS + 1_000 });
  await fetchDepartures(config, streetcar, { now: NOW_MS + 2_000 });
  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get('stopId')),
    ['247', '10935'],
  );
  assert.equal(calls[0].url, NETWORK.realtime.stopFeed.url('247'));
  assert.match(calls[0].headers['User-Agent'], /^gladys-ttc\//);

  // A new interval reads again; two concurrent askers share one request.
  await Promise.all([
    getStopFeed(config, stop, { now: NOW_MS + 60_000 }),
    getStopFeed(config, stop, { now: NOW_MS + 60_000 }),
  ]);
  assert.equal(calls.length, 3);
});

test('the NextBus answer becomes stop time updates', () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?>
<body copyright="All data copyright Toronto Transit Commission 2026.">
<predictions agencyTitle="Toronto Transit Commission" routeTitle="96-Wilson" routeTag="96" stopTag="8547">
  <direction title="East - 96b Wilson towards York Mills Station via Martin Grove &amp; Westhumber">
  <prediction epochTime="1791723882231" seconds="335" minutes="5" isDeparture="false" branch="96B" tripTag="50889214" />
  <prediction epochTime="nope" tripTag="x" />
  </direction>
</predictions>
<predictions routeTag="396" stopTag="8547" dirTitleBecauseNoPredictions="East - 396 Wilson">
</predictions>
</body>`;
  assert.deepEqual(parseNextBusPredictions(xml, '1658').stopTimes, [
    {
      stopId: '1658',
      routeId: '96',
      tripId: '50889214',
      headsign: 'East - 96b Wilson towards York Mills Station via Martin Grove & Westhumber',
      tripScheduleRelationship: 0,
      scheduleRelationship: 0,
      arrival: { time: 1791723882 },
    },
  ]);
  // A stop NextBus does not know (the subway platforms): no departure.
  const error = '<body><Error shouldRetry="false">stopId=13816 is not valid</Error></body>';
  assert.deepEqual(parseNextBusPredictions(error, '13816').stopTimes, []);
});

test('a departure just past its time stays on the board for a few seconds', () => {
  const board = departuresFromFeed(
    {
      stopTimes: [
        {
          stopId: '247',
          routeId: '114',
          tripScheduleRelationship: 0,
          scheduleRelationship: 0,
          arrival: { time: NOW - 20 },
        },
      ],
    },
    { id: '247', routes: [] },
    NOW,
  );
  assert.equal(board[0].minutes, 0);
  assert.equal(board[0].headsign, '');
});

test('a refusal of the open feed is no key problem, and is not cached', async () => {
  const calls = stubFetch({ [PREDICTIONS_PATH]: { status: 403, body: '' } });
  const [stop] = config.watched.stops;
  await assert.rejects(fetchDepartures(config, stop, { now: NOW_MS }), (err) => {
    assert.ok(err instanceof RealtimeApiError);
    assert.equal(err.status, 403);
    assert.equal(err.userMessage, undefined);
    return true;
  });
  await assert.rejects(fetchDepartures(config, stop, { now: NOW_MS + 1_000 }));
  assert.equal(calls.length, 2);
  assert.equal(realtimeErrorFor(403, 'Quota exceeded', 'x').userMessage, undefined);
  assert.match(realtimeErrorFor(429, '', 'x').userMessage.en, /rate limiting/);
  assert.equal(realtimeErrorFor(503, 'Service Unavailable', 'x').userMessage, undefined);
});

test('a network error is reported, and a key would be masked', async () => {
  globalThis.fetch = async (url) => {
    throw new Error(`connect ECONNREFUSED ${url}`);
  };
  await assert.rejects(
    fetchDepartures(config, config.watched.stops[0], { now: NOW_MS }),
    /Predictions feed unreachable/,
  );
  assert.equal(redact('a k3y b k3y', 'k3y'), 'a *** b ***');
  assert.equal(redact('text', ''), 'text');
});
