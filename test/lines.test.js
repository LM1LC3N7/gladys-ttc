// -----------------------------------------------------------------------------
// The line status, from the TTC live alerts translated to GTFS-Realtime
// alerts (src/network.js).
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAlert,
  fetchLineStatus,
  isActive,
  LINE_STATUS,
  parseAlerts,
  pickText,
} from '../src/api/lines.js';
import { clearRealtimeCache } from '../src/api/realtime.js';
import { ALERT_EFFECT, ALERT_SEVERITY } from '../src/api/gtfsRealtime.js';
import { normalizeConfig } from '../src/config.js';
import { NETWORK, parseTtcAlerts } from '../src/network.js';
import { alertsFeed, lineAlert } from './helpers/fixtures.js';
import { restoreFetch, stubFetch } from './helpers/stubFetch.js';

const NOW_MS = 1_760_100_000_000;
const NOW = NOW_MS / 1000;
const ALERTS = new URL(NETWORK.realtime.lineAlerts.url).pathname;
const iso = (seconds) => new Date(seconds * 1000).toISOString();

const statuses = (status) => Object.fromEntries(status.lines.map((line) => [line.id, line.status]));
const parse = (alerts, language = 'en') =>
  parseAlerts(parseTtcAlerts(alertsFeed(alerts)), { language, now: NOW_MS });

beforeEach(() => clearRealtimeCache());
afterEach(() => restoreFetch());

test('no alert: every line runs normally', () => {
  const status = parse([]);
  assert.ok(status.lines.every((line) => line.status === LINE_STATUS.NORMAL && !line.message));
  assert.deepEqual(
    status.lines.map((line) => line.id),
    NETWORK.lines.map((line) => line.id),
  );
});

test('a line alert disrupts its line only, with its message', () => {
  const status = parse(
    [
      lineAlert(
        'line2',
        'Line 2 Bloor-Danforth: There is no subway service between Kipling and Jane.',
      ),
    ],
    'fr',
  );
  assert.equal(statuses(status).line2, LINE_STATUS.DISRUPTED);
  assert.equal(statuses(status).line1, LINE_STATUS.NORMAL);
  // No French text: the English one rather than nothing.
  assert.equal(
    status.lines.find((line) => line.id === 'line2').message,
    'Line 2 Bloor-Danforth: There is no subway service between Kipling and Jane.',
  );
});

test('slow zones, announcements, other routes and future alerts leave the line running', () => {
  const status = parse([
    // A standing slow zone: "Minor", whatever its effect says.
    lineAlert('line1', 'Line 1 Yonge-University: Subway trains will move slower than usual.', {
      effect: 'SIGNIFICANT_DELAYS',
      severity: 'Minor',
    }),
    // Monday's late opening, announced on Friday: the child alert is the event.
    lineAlert('line2', 'Line 2 Bloor-Danforth: On Monday, service will start by 11 a.m.', {
      effect: 'REDUCED_SERVICE',
      childAlerts: [{ id: 'later', startTime: iso(NOW + 86_400 * 3) }],
    }),
    // A streetcar detour: not a line of the device.
    { ...lineAlert('line4'), route: '506', effect: 'DETOUR' },
    // Next weekend's closure.
    lineAlert('line4', 'Line 4 Sheppard: Weekend closure', {
      activePeriod: { start: iso(NOW + 86_400 * 5), end: iso(NOW + 86_400 * 6) },
    }),
  ]);
  assert.equal(statuses(status).line1, LINE_STATUS.NOTICE);
  assert.equal(statuses(status).line2, LINE_STATUS.NOTICE);
  assert.equal(statuses(status).line4, LINE_STATUS.NORMAL);
});

test('the worst status wins, with the messages of that status only', () => {
  const status = parse([
    lineAlert('line1', 'Slow zone.', { effect: 'SIGNIFICANT_DELAYS', severity: 'Minor' }),
    lineAlert('line1', 'No service between Union and St Andrew.'),
  ]);
  const line1 = status.lines.find((line) => line.id === 'line1');
  assert.equal(line1.status, LINE_STATUS.DISRUPTED);
  assert.equal(line1.message, 'No service between Union and St Andrew.');
});

test('the TTC alerts become GTFS-Realtime alerts', () => {
  const feed = parseTtcAlerts(
    alertsFeed(
      [
        lineAlert('line5', 'Line 5 Eglinton: Delays', {
          effect: 'SIGNIFICANT_DELAYS',
          severity: 'Major',
          activePeriod: { start: '2025-10-10T05:00:00Z', end: '2025-10-11T05:00:00Z' },
        }),
        // An accessibility alert names several routes.
        { ...lineAlert('line1'), route: '1,5,13', effect: 'SOMETHING_NEW', headerText: '' },
      ],
      '2025-10-10T12:00:00Z',
    ),
  );
  assert.equal(feed.timestamp, Date.parse('2025-10-10T12:00:00Z') / 1000);
  const [delays, other] = feed.alerts;
  assert.equal(delays.effect, ALERT_EFFECT.SIGNIFICANT_DELAYS);
  assert.equal(delays.severity, ALERT_SEVERITY.INFO);
  assert.deepEqual(delays.activePeriods, [
    {
      start: Date.parse('2025-10-10T05:00:00Z') / 1000,
      end: Date.parse('2025-10-11T05:00:00Z') / 1000,
    },
  ]);
  assert.deepEqual(delays.informedEntities, [{ routeId: '5' }]);
  assert.equal(other.effect, ALERT_EFFECT.UNKNOWN_EFFECT);
  assert.equal(other.severity, ALERT_SEVERITY.SEVERE);
  assert.deepEqual(
    other.informedEntities.map((entity) => entity.routeId),
    ['1', '5', '13'],
  );
  // "0001-01-01" is the API's "no end"; a missing title falls back to the header.
  assert.equal(other.activePeriods[0].end, undefined);
  assert.deepEqual(parseTtcAlerts(null), { timestamp: undefined, alerts: [] });
});

test('helpers: texts, periods, effects', () => {
  const texts = [
    { text: 'Hello', language: 'en-CA' },
    { text: 'Bonjour', language: 'fr' },
  ];
  assert.equal(pickText(texts, 'fr'), 'Bonjour');
  assert.equal(pickText(texts, 'en'), 'Hello');
  assert.equal(pickText([{ text: 'Only' }], 'fr'), 'Only');
  assert.equal(pickText(undefined, 'fr'), '');
  assert.equal(isActive({ activePeriods: [] }, NOW), true);
  assert.equal(isActive({ activePeriods: [{ start: NOW - 10 }] }, NOW), true);
  assert.equal(isActive({ activePeriods: [{ end: NOW - 10 }] }, NOW), false);
  assert.equal(classifyAlert({ effect: 3 }), LINE_STATUS.DISRUPTED);
  assert.equal(classifyAlert({ effect: 7, severity: 4 }), LINE_STATUS.DISRUPTED);
  assert.equal(classifyAlert({ effect: 7 }), LINE_STATUS.NOTICE);
});

test('the status is read from the TTC live alerts, without any key', async () => {
  const calls = stubFetch({ [ALERTS]: alertsFeed([lineAlert('line6')]) });
  const status = await fetchLineStatus(normalizeConfig(), { now: NOW_MS });
  assert.equal(statuses(status).line6, LINE_STATUS.DISRUPTED);
  assert.equal(calls[0].url, NETWORK.realtime.lineAlerts.url);
  assert.equal(calls[0].headers.Accept, 'application/json');
});

test('an alerts answer that is not JSON is an error the logs can read', async () => {
  stubFetch({ [ALERTS]: { status: 200, body: '<html>maintenance</html>' } });
  await assert.rejects(fetchLineStatus(normalizeConfig(), { now: NOW_MS }), /else than JSON/);
});
