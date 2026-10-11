// -----------------------------------------------------------------------------
// "Near my home": the stops and stations suggested from the house location,
// and the connection status that tells the user what to do next.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import { bikeRoutes, stopTimesPayload } from './helpers/fixtures.js';
import { normalizeConfig } from '../src/config.js';
import {
  clearSuggestions,
  getSuggestions,
  refreshSuggestions,
  suggestedStopLabel,
} from '../src/devices/suggestions.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { clearTransitousCache } from '../src/api/transitous.js';
import { clearBikeCache } from '../src/api/bikes.js';
import { describeStatus, inventory } from '../src/status.js';

function routes() {
  // Transitous answers for the Union Station group: the streetcar platform
  // gets its 509, the subway platform nothing of its own.
  const streetcar = {
    stopId: '10935',
    routeId: '509',
    shortName: '509',
    headsign: 'West - 509 Harbourfront towards Exhibition',
  };
  return {
    '/v5/stoptimes': stopTimesPayload(Date.now(), [
      { minutes: 3, ...streetcar },
      { minutes: 9, ...streetcar },
    ]),
    ...bikeRoutes(),
  };
}

beforeEach(() => {
  clearSuggestions();
  clearTransitousCache();
  clearBikeCache();
});
afterEach(() => restoreFetch());

test('the closest stops and stations are suggested, named the way people know them', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  const config = normalizeConfig({ nearby_stops: 2, nearby_bike_stations: 2 });

  const found = await refreshSuggestions(gladys, config);

  assert.equal(found.status, 'ok');
  // The Line 1 platform and the streetcar platform under Union Station.
  assert.deepEqual(
    found.stops.map((stop) => stop.id),
    ['13816', '10935'],
  );
  // Union Station is around the corner, Queens Quay / Yonge St 550 m away;
  // Fort York (1.5 km) is beyond the 1 km radius.
  assert.deepEqual(
    found.bikeStations.map((station) => station.id),
    ['7033', '7168'],
  );

  // Without typing anything, the Discovery screen offers them, each name
  // saying what it is.
  const names = buildDiscoveredDevices(gladys, config).map((device) => device.name);
  assert.deepEqual(names, [
    'TTC – Subway and LRT',
    'TTC – Union Station - Northbound Platform Towards Finch',
    'TTC – Union Station (509 → Exhibition)',
    'Bike Share – Union Station',
    'Bike Share – Queens Quay / Yonge St',
  ]);
});

test('no located house, no permission, nothing wanted: each has its own status', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  const config = normalizeConfig({});

  gladys.houses = [{ id: 'h', name: 'Home', latitude: null, longitude: null }];
  assert.equal((await refreshSuggestions(gladys, config)).status, 'no_location');

  gladys.houses = new Error('HTTP 403');
  assert.equal((await refreshSuggestions(gladys, config)).status, 'no_house');

  const off = normalizeConfig({ nearby_stops: 0, nearby_bike_stations: 0 });
  assert.equal((await refreshSuggestions(gladys, off)).status, 'disabled');
});

test('a house far from the network gets nothing, and a failing bike feed says so', async () => {
  stubFetch({ 'gbfs.json': { status: 503, body: '' } });
  const gladys = createFakeGladys();
  gladys.houses = [{ id: 'h', name: 'Cottage', latitude: 50.5, longitude: -120.3 }];
  const found = await refreshSuggestions(gladys, normalizeConfig({}));
  assert.equal(found.status, 'failed');
  assert.deepEqual(getSuggestions().stops, []);
});

test('a name the user typed is never prefixed, a known station gets its name', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  // Station 7168 is read once (the station list is then known), and typed
  // without a name.
  const config = normalizeConfig({
    stops: '247:My bus',
    bike_stations: '7168',
    nearby_stops: 0,
    nearby_bike_stations: 1,
  });
  await refreshSuggestions(gladys, config);
  assert.deepEqual(
    buildDiscoveredDevices(gladys, config).map((device) => device.name),
    [
      'TTC – Subway and LRT',
      'My bus',
      'Bike Share – Queens Quay / Yonge St',
      'Bike Share – Union Station',
    ],
  );
});

test('a suggested label: the name, then the first routes and their direction', () => {
  assert.equal(suggestedStopLabel({ code: '1', name: 'Main St' }, null), 'Main St');
  assert.equal(suggestedStopLabel({ code: '1', name: '' }, null), '1');
  const busy = {
    name: 'Hub',
    routes: Array.from({ length: 12 }, (_, index) => ({
      route: String(index + 1),
      headsigns: ['Somewhere far away'],
    })),
  };
  const label = suggestedStopLabel({ code: '1', name: 'Hub' }, busy);
  assert.match(label, /^Hub \(1 → Somewhere far away, 2 → Somewhere far away, …\)$/);
});

test('status: nothing found asks to locate the house', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  gladys.houses = [];
  const nothing = normalizeConfig({ watch_lines: false });
  await refreshSuggestions(gladys, nothing);
  const status = describeStatus(gladys, nothing);
  assert.equal(status.connected, false);
  assert.match(status.message.fr, /Paramètres → Maisons/);

  // The line device needs no house: it is offered, and the house still asked for.
  const lines = describeStatus(gladys, normalizeConfig({}));
  assert.equal(lines.connected, true);
  assert.match(lines.message.en, /^Ready: the lines to add\..*Settings → Houses/);
});

test('status: devices waiting point to the Discovery tab, no key to ask for', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  const config = normalizeConfig({ nearby_stops: 2, nearby_bike_stations: 1 });
  await refreshSuggestions(gladys, config);

  const status = describeStatus(gladys, config);
  assert.equal(status.connected, true);
  assert.equal(
    status.message.fr,
    'Prêt : 2 arrêts, 1 station Bike Share Toronto et les lignes à ajouter. Ouvrez l’onglet ' +
      '« Découverte » de cette ' +
      'intégration et cliquez sur « Ajouter ».',
  );
});

test('status: once everything is added, what is watched (no quota to count)', async () => {
  stubFetch(routes());
  const gladys = createFakeGladys();
  const config = normalizeConfig({ nearby_stops: 1, nearby_bike_stations: 0 });
  await refreshSuggestions(gladys, config);
  gladys.devices = buildDiscoveredDevices(gladys, config);

  const status = describeStatus(gladys, config);
  assert.equal(status.message.en, 'Connected. Watching 1 stop and the lines.');
});

test('status: the open feed never waits for a key', () => {
  const config = normalizeConfig({ stops: '247', schedule_without_key: false });
  const status = describeStatus(createFakeGladys(), config);
  assert.equal(status.connected, true);
  assert.doesNotMatch(status.message.en, /key/);
});

test('inventory', () => {
  assert.deepEqual(inventory({ stops: 1, stations: 2, lines: true }), {
    en: '1 stop, 2 Bike Share Toronto stations and the lines',
    fr: '1 arrêt, 2 stations Bike Share Toronto et les lignes',
  });
});
