// -----------------------------------------------------------------------------
// Bike share GBFS client. The payloads follow the live Bike Share Toronto feed (GBFS 2.3,
// e-bikes counted by vehicle type).
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearBikeCache,
  electricBikesOf,
  feedUrl,
  fetchStation,
  fold,
  mergeStations,
  searchStations,
} from '../src/api/bikes.js';
import { normalizeConfig } from '../src/config.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { bikeRoutes, DISCOVERY } from './helpers/fixtures.js';

const config = normalizeConfig({ bike_stations: '7033', language: 'en' });

beforeEach(() => clearBikeCache());
afterEach(() => restoreFetch());

test('a station joins its information, its live counts and its e-bikes', async () => {
  stubFetch(bikeRoutes());
  const station = await fetchStation(config, { id: '7033' });
  assert.deepEqual(station, {
    id: '7033',
    name: 'Union Station',
    capacity: 43,
    lat: 43.645609,
    lon: -79.380386,
    bikes: 8,
    electricBikes: 2,
    docks: 12,
    installed: true,
    renting: true,
    returning: false,
    lastReported: 1791644363,
  });
});

test('the feeds of the configured language are preferred, others will do', () => {
  assert.equal(
    feedUrl(DISCOVERY, 'station_status', 'en'),
    'https://gbfs.example/en/station_status.json',
  );
  assert.equal(
    feedUrl({ data: { en: DISCOVERY.data.en } }, 'station_status', 'fr'),
    'https://gbfs.example/en/station_status.json',
  );
  assert.throws(() => feedUrl({ data: {} }, 'station_status', 'fr'), /no "station_status"/);
});

test('the e-bikes: the count of the feed, else the electric vehicle types', () => {
  const electric = new Set(['2']);
  assert.equal(electricBikesOf({ num_ebikes_available: 3 }, electric), 3);
  assert.equal(
    electricBikesOf(
      {
        vehicle_types_available: [
          { vehicle_type_id: '2', count: 4 },
          { vehicle_type_id: '1', count: 9 },
        ],
      },
      electric,
    ),
    4,
  );
  // No way to tell: unknown, not zero.
  assert.equal(electricBikesOf({ num_bikes_available: 5 }, electric), undefined);
});

test('the network files are read once for every station of a cycle', async () => {
  const calls = stubFetch(bikeRoutes());
  await fetchStation(config, { id: '7033' }, { now: 1000 });
  await fetchStation(config, { id: '7168' }, { now: 2000 });
  assert.equal(calls.length, 4);
  // The live counts expire with the refresh interval, the station list later.
  await fetchStation(config, { id: '7033' }, { now: 1000 + config.bike_poll_frequency * 1000 });
  assert.equal(calls.length, 5);
});

test('a station missing from the feed is a removed station, not a failed read', async () => {
  stubFetch(bikeRoutes());
  const station = await fetchStation(config, { id: '999' });
  assert.equal(station.absent, true);
  assert.equal(station.installed, false);
  assert.equal(station.bikes, 0);
});

test('an empty network is a broken feed, not every station removed', async () => {
  stubFetch({
    ...bikeRoutes(),
    '/station_status.json': { data: { stations: [] } },
    '/station_information.json': { data: { stations: [] } },
  });
  await assert.rejects(fetchStation(config, { id: '7033' }), /lists no station/);
});

test('the search ignores case and accents', async () => {
  stubFetch(bikeRoutes());
  const results = await searchStations(config, 'QUEENS quay');
  assert.deepEqual(
    results.map((station) => station.id),
    ['7168'],
  );
  assert.equal(fold('Côte-des-Neiges'), 'cote des neiges');
});

test('mergeStations tolerates a status for a station missing from the list', () => {
  const stations = mergeStations({ data: {} }, { data: { stations: [{ station_id: 7 }] } });
  assert.equal(stations.get('7').name, '7');
  assert.equal(stations.get('7').bikes, undefined);
});
