// -----------------------------------------------------------------------------
// Dashboard widgets: every content must pass the SDK's own validator (the
// vocabulary and the budget the core enforces), and no failure may reach the
// dashboard as an exception.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';
import {
  alertsFeed,
  bikeRoutes,
  lineAlert,
  PREDICTIONS_PATH,
  predictionsFeed,
  stopTimesPayload,
} from './helpers/fixtures.js';
import { normalizeConfig } from '../src/config.js';
import { clearReadings } from '../src/devices/readings.js';
import { clearRealtimeCache } from '../src/api/realtime.js';
import { absentStation, clearBikeCache } from '../src/api/bikes.js';
import { bikeStationContent, departuresContent } from '../src/widgets/index.js';
import { truncate, WIDGETS } from '../src/widgets/index.js';
import { NETWORK } from '../src/network.js';

const ALERTS_PATH = new URL(NETWORK.realtime.lineAlerts.url).pathname;

const config = normalizeConfig({
  stops: '247',
  bike_stations: '7033',
  language: 'fr',
});

function routes(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    [PREDICTIONS_PATH]: predictionsFeed(
      Array.from({ length: 12 }, (_, index) => ({
        stopId: '247',
        routeId: index % 2 ? '202' : '114',
        tripId: `T${index}`,
        time: now + index * 240,
      })),
    ),
    [ALERTS_PATH]: alertsFeed([lineAlert('line2', 'x'.repeat(600))]),
    ...bikeRoutes(),
    ...extra,
  };
}

function assertValid(content) {
  assert.deepEqual(validateWidgetContent(content), []);
}

beforeEach(() => {
  clearReadings();
  clearRealtimeCache();
  clearBikeCache();
});
afterEach(() => restoreFetch());

test('the departures board is valid and capped', async () => {
  stubFetch(routes());
  const content = await WIDGETS.departures(createFakeGladys(), {
    settings: { stop: 'transit-stop:247' },
    config,
  });
  assertValid(content);
  const board = content.components.find((component) => component.type === 'status');
  assert.equal(board.items.length, 8);
  // NextBus gives no delay: every prediction is plain real time.
  assert.ok(board.items.every((item) => item.color === 'success'));
});

test('the line card is valid, and truncates a long message to the budget', async () => {
  stubFetch(routes());
  const content = await WIDGETS.line_status(createFakeGladys(), { settings: {}, config });
  assertValid(content);
  const status = content.components.find((component) => component.type === 'status');
  assert.deepEqual(
    status.items.map((item) => item.color),
    ['success', 'danger', 'success', 'success', 'success'],
  );
});

test('the bike station card is valid', async () => {
  stubFetch(routes());
  const content = await WIDGETS.bike_station(createFakeGladys(), {
    settings: { station: 'bike-station:7033' },
    config,
  });
  assertValid(content);
});

test('failures become a card that says what is wrong', async () => {
  stubFetch(routes({ [ALERTS_PATH]: { status: 403, body: '' } }));
  const refused = await WIDGETS.line_status(createFakeGladys(), { settings: {}, config });
  assertValid(refused);
  assert.match(refused.components[0].text.en, /could not be read right now/);

  const unset = await WIDGETS.departures(createFakeGladys(), { settings: {}, config });
  assertValid(unset);
  assert.match(unset.components[0].text.en, /Choose a stop/);

  const notWatched = await WIDGETS.line_status(createFakeGladys(), {
    settings: {},
    config: normalizeConfig({ watch_lines: false }),
  });
  assert.match(notWatched.components[0].text.fr, /pas surveillées/);
});

test('a slow API gets a loading card rather than a dashboard error', async () => {
  // An answer that comes, but long after the card's deadline.
  globalThis.fetch = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, status: 503, text: async () => '' }), 100),
    );
  const content = await WIDGETS.line_status(
    createFakeGladys(),
    { settings: {}, config },
    { deadlineMs: 10 },
  );
  assertValid(content);
  assert.match(content.components[0].text.en, /longer than usual/);
});

test('truncate', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 5), 'abcd…');
});

test('a scheduled board is grey, marked "~", and asks for no key', async () => {
  const subway = (minutes, extra = {}) => ({
    minutes,
    stopId: '13816',
    routeId: '1',
    shortName: '1',
    headsign: 'Line 1 (Yonge-University) towards Finch Station',
    ...extra,
  });
  stubFetch({
    '/v5/stoptimes': stopTimesPayload(Date.now(), [
      subway(5),
      subway(20, { headsign: 'Line 1 (Yonge-University) towards Eglinton Station' }),
      // Real time Transitous has: green, no "~".
      subway(25, { realTime: true }),
    ]),
  });
  const content = await WIDGETS.departures(createFakeGladys(), {
    settings: { stop: 'transit-stop:13816' },
    config: normalizeConfig({ stops: '13816', language: 'fr' }),
  });
  assertValid(content);
  const board = content.components.find((component) => component.type === 'status');
  assert.deepEqual(
    board.items.map((item) => [item.label.fr, item.color]),
    [
      ['Ligne 1 → Finch Station', 'neutral'],
      ['Ligne 1 → Eglinton Station', 'neutral'],
      ['Ligne 1 → Finch Station', 'success'],
    ],
  );
  assert.match(board.items[0].value, /^~[45] min$/);
  // The TTC has no prediction for its subway: no key would change that.
  assert.equal(content.components.at(-1).text.fr, '~ horaire prévu.');
});

test('an empty board says so', () => {
  const content = departuresContent('Arrêt', []);
  assertValid(content);
  assert.match(content.components[1].text.fr, /Aucun passage/);
});

test('a removed bike station gets a card that says so, not three zeros', () => {
  const content = bikeStationContent('Bike Share – Union Station', absentStation('7033'));
  assertValid(content);
  assert.equal(
    content.components.some((component) => component.type === 'value'),
    false,
  );
  assert.match(content.components[1].text.fr, /retirée pour la saison/);
});
