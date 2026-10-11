// -----------------------------------------------------------------------------
// The hand-written GTFS-Realtime decoder (src/api/gtfsRealtime.js): trip
// updates and service alerts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_EFFECT,
  decodeAlerts,
  decodeTripUpdates,
  GtfsRealtimeDecodeError,
  STOP_SCHEDULE_RELATIONSHIP,
  TRIP_SCHEDULE_RELATIONSHIP,
} from '../src/api/gtfsRealtime.js';
import { encodeFeed } from './helpers/gtfsRealtimeEncoder.js';

const NOW = 1_760_100_000;

test('decodes the header timestamp and the stop times of the watched stops only', () => {
  const feed = encodeFeed({
    timestamp: NOW,
    entities: [
      {
        id: 'a',
        tripUpdate: {
          trip: { tripId: 'T1', routeId: '24', directionId: 1, startDate: '20261010' },
          stopTimeUpdates: [
            { stopSequence: 3, stopId: '52743', arrival: { time: NOW + 300, delay: 60 } },
            { stopSequence: 4, stopId: '99999', arrival: { time: NOW + 400 } },
          ],
        },
      },
    ],
  });

  const decoded = decodeTripUpdates(feed, ['52743']);

  assert.equal(decoded.timestamp, NOW);
  assert.deepEqual(decoded.stopTimes, [
    {
      stopId: '52743',
      routeId: '24',
      tripId: 'T1',
      directionId: 1,
      tripScheduleRelationship: TRIP_SCHEDULE_RELATIONSHIP.SCHEDULED,
      scheduleRelationship: STOP_SCHEDULE_RELATIONSHIP.SCHEDULED,
      stopSequence: 3,
      arrival: { time: NOW + 300, delay: 60 },
      departure: undefined,
    },
  ]);
});

test('reads a negative delay (a bus running early) as a negative number', () => {
  const feed = encodeFeed({
    entities: [
      {
        tripUpdate: {
          trip: { tripId: 'T1', routeId: '24' },
          stopTimeUpdates: [{ stopId: '52743', departure: { time: NOW, delay: -45 } }],
        },
      },
    ],
  });
  assert.equal(decodeTripUpdates(feed, ['52743']).stopTimes[0].departure.delay, -45);
});

test('pairs the trip with its stop times when the trip comes last on the wire', () => {
  const feed = encodeFeed({
    entities: [
      {
        tripLast: true,
        tripUpdate: {
          trip: { tripId: 'T9', routeId: '747', scheduleRelationship: 3 },
          stopTimeUpdates: [{ stopId: '52743', arrival: { time: NOW } }],
        },
      },
    ],
  });
  const [stopTime] = decodeTripUpdates(feed, ['52743']).stopTimes;
  assert.equal(stopTime.routeId, '747');
  assert.equal(stopTime.tripScheduleRelationship, TRIP_SCHEDULE_RELATIONSHIP.CANCELED);
});

test('skips the fields it does not read and the deleted entities', () => {
  const feed = encodeFeed({
    entities: [
      { id: 'vehicle-only', vehicle: { timestamp: NOW } },
      {
        id: 'deleted',
        isDeleted: true,
        tripUpdate: { trip: { tripId: 'gone' }, stopTimeUpdates: [{ stopId: '52743' }] },
      },
      {
        id: 'kept',
        vehicle: { timestamp: NOW },
        tripUpdate: {
          trip: { tripId: 'T2', routeId: '51' },
          stopTimeUpdates: [{ stopId: '52743', scheduleRelationship: 1, arrival: { time: NOW } }],
        },
      },
    ],
  });
  const { stopTimes } = decodeTripUpdates(feed, ['52743']);
  assert.equal(stopTimes.length, 1);
  assert.equal(stopTimes[0].tripId, 'T2');
  assert.equal(stopTimes[0].scheduleRelationship, STOP_SCHEDULE_RELATIONSHIP.SKIPPED);
});

test('an empty watch list still walks the feed', () => {
  const feed = encodeFeed({ timestamp: NOW, entities: [{ tripUpdate: { trip: {} } }] });
  assert.deepEqual(decodeTripUpdates(feed, []), { timestamp: NOW, stopTimes: [] });
});

test('a truncated payload is reported as a malformed feed', () => {
  const feed = encodeFeed({
    timestamp: NOW,
    entities: [{ tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdates: [{ stopId: '1' }] } }],
  });
  assert.throws(
    () => decodeTripUpdates(feed.subarray(0, feed.length - 3), ['1']),
    GtfsRealtimeDecodeError,
  );
  // An HTML error page served with a 200 is not a feed either.
  assert.throws(
    () => decodeTripUpdates(new TextEncoder().encode('<html>Maintenance</html>'), ['1']),
    GtfsRealtimeDecodeError,
  );
});

test('decodes a network-sized feed without building the stop times it does not keep', () => {
  // 3,000 trips of 40 stops: the order of magnitude of a large bus network.
  const entities = Array.from({ length: 3000 }, (_, trip) => ({
    id: `e${trip}`,
    tripUpdate: {
      trip: { tripId: `T${trip}`, routeId: String(trip % 200) },
      stopTimeUpdates: Array.from({ length: 40 }, (__, stop) => ({
        stopSequence: stop,
        stopId: String(50000 + ((trip + stop) % 9000)),
        arrival: { time: NOW + stop * 60 },
      })),
    },
  }));
  const feed = encodeFeed({ timestamp: NOW, entities });
  const { stopTimes } = decodeTripUpdates(feed, ['50042']);
  assert.ok(stopTimes.length > 0);
  assert.ok(stopTimes.every((stopTime) => stopTime.stopId === '50042'));
});

// --- Service alerts ------------------------------------------------------------

test('decodes the alerts: periods, entities, effect, severity and translated texts', () => {
  const feed = encodeFeed({
    timestamp: NOW,
    entities: [
      {
        id: 'a1',
        alert: {
          activePeriods: [{ start: NOW - 60, end: NOW + 3600 }, { start: NOW + 7200 }],
          informedEntities: [
            { agencyId: 'TL', routeId: '30053' },
            { routeType: 1, stopId: '8039' },
          ],
          cause: 3,
          effect: 1,
          severity: 4,
          headerText: [
            { text: 'Expo Line disruption', language: 'en' },
            { text: 'Perturbation', language: 'fr' },
          ],
          descriptionText: [{ text: 'Shuttle buses' }],
        },
      },
      // A trip update in the same feed is skipped by the alerts decoder.
      { tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdates: [{ stopId: '1' }] } },
      { id: 'gone', isDeleted: true, alert: { effect: 1 } },
    ],
  });

  const decoded = decodeAlerts(feed);
  assert.equal(decoded.timestamp, NOW);
  assert.deepEqual(decoded.alerts, [
    {
      id: 'a1',
      activePeriods: [{ start: NOW - 60, end: NOW + 3600 }, { start: NOW + 7200 }],
      informedEntities: [
        { agencyId: 'TL', routeId: '30053' },
        { routeType: 1, stopId: '8039' },
      ],
      cause: 3,
      effect: ALERT_EFFECT.NO_SERVICE,
      severity: 4,
      headerText: [
        { text: 'Expo Line disruption', language: 'en' },
        { text: 'Perturbation', language: 'fr' },
      ],
      descriptionText: [{ text: 'Shuttle buses', language: undefined }],
    },
  ]);
});

test('an empty alerts feed decodes to no alert', () => {
  assert.deepEqual(decodeAlerts(encodeFeed({ timestamp: NOW })), { timestamp: NOW, alerts: [] });
});
