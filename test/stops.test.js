// -----------------------------------------------------------------------------
// The stop table (gtfs/) and the script that generates it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  fold,
  normalizeRoute,
  routeLabel,
  searchStops,
  stopByCode,
  stopsNear,
} from '../src/api/stops.js';
import {
  buildStops,
  parseCsv,
  routeLabel as gtfsRouteLabel,
  stopsServedOnlyBy,
  zipEntries,
} from '../scripts/update-stops.mjs';

test('a stop code gives its name, its position and its GTFS stop_ids', () => {
  // At the TTC the code on the sign is the stop_id.
  const stop = stopByCode('247');
  assert.equal(stop.name, 'Bay St at Front St West - Union Station');
  assert.deepEqual(stop.ids, ['247']);
  assert.deepEqual(stop.query, ['247']);
  assert.equal(stop.scheduleOnly, false);
  // A subway platform: the real-time feed has no prediction for it.
  const platform = stopByCode('13816');
  assert.equal(platform.name, 'Union Station - Northbound Platform Towards Finch');
  assert.equal(platform.scheduleOnly, true);
  assert.equal(stopByCode('00000'), null);
});

test('route ids become the labels riders use', () => {
  assert.equal(routeLabel('114'), '114');
  assert.equal(routeLabel('1'), '1');
  assert.equal(routeLabel('nope'), null);
  assert.equal(normalizeRoute(' 0114 '), '114');
  assert.equal(normalizeRoute('0'), '0');
  assert.equal(normalizeRoute('96b'), '96B');
});

test('the stops near a point come closest first, within the radius', () => {
  const near = stopsNear({ lat: 43.6455, lon: -79.3797 }, 100);
  assert.ok(near.length > 0);
  assert.ok(near.every((stop) => stop.distance <= 100));
  assert.deepEqual(
    near.map((stop) => stop.distance),
    [...near.map((stop) => stop.distance)].sort((a, b) => a - b),
  );
  assert.ok(near.some((stop) => stop.code === '10935'));
});

test('the search matches every word of the query, or the code itself', () => {
  assert.deepEqual(
    searchStops('bay front union').map((stop) => stop.code),
    ['247', '246'],
  );
  assert.equal(searchStops('247')[0].code, '247');
  assert.deepEqual(searchStops('   '), []);
  // The stop named exactly so comes first: the streetcar platform, not a
  // street corner nor a subway platform.
  assert.equal(searchStops('union station')[0].code, '10935');
  assert.equal(fold('Côte-des-Neiges'), 'cote des neiges');
});

test('the CSV parser handles quotes, commas in fields and a byte order mark', () => {
  const rows = parseCsv('﻿stop_id,stop_name\r\n1,"Main St, ""North"""\n2,Plain\n');
  assert.deepEqual(rows, [
    { stop_id: '1', stop_name: 'Main St, "North"' },
    { stop_id: '2', stop_name: 'Plain' },
  ]);
});

test('the stop table groups the platforms of a station under its code', () => {
  const rows = parseCsv(
    [
      'stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station',
      'S,3009,RIDEAU,45.4262,-75.6917,1,',
      'A,3009,RIDEAU A,45.4261,-75.6916,0,S',
      'B,3009,RIDEAU B,45.4263,-75.6918,0,S',
      'E,,RIDEAU ENTRANCE,45.4263,-75.6918,2,S',
      'X,0513,WOODROFFE / STRANDHERD,45.27,-75.75,0,',
      'Y,0513,STRANDHERD / WOODROFFE,45.27,-75.75,0,',
      'Z,,NO CODE,45,-75,0,',
    ].join('\n'),
  );
  const stops = buildStops(rows, (row) => row.stop_name);
  assert.deepEqual(stops, [
    ['0513', 'WOODROFFE / STRANDHERD', 45.27, -75.75, ['X', 'Y'], ['X', 'Y']],
    ['3009', 'RIDEAU', 45.4262, -75.6917, ['S', 'A', 'B'], ['S']],
  ]);
  assert.equal(gtfsRouteLabel({ route_id: '1', route_short_name: '099' }), '99');
  assert.equal(
    gtfsRouteLabel({ route_id: '2', route_short_name: '', route_long_name: 'Expo Line' }),
    'Expo Line',
  );
});

test('a code whose stops only the timetable serves is marked', () => {
  const trips = 'route_id,service_id,trip_id\n1,1,T1\n114,1,T2\n';
  const stopTimes = [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'T1,08:00:00,08:00:00,13816,1',
    'T1,08:02:00,08:02:00,SHARED,2',
    'T2,08:01:00,08:01:00,247,1',
    'T2,08:03:00,08:03:00,SHARED,2',
    '',
  ].join('\r\n');
  const only = stopsServedOnlyBy(trips, stopTimes, ['1']);
  // A stop the buses serve too keeps its real time.
  assert.deepEqual([...only], ['13816']);
  const rows = parseCsv(
    [
      'stop_id,stop_code,stop_name,stop_lat,stop_lon',
      '13816,13816,PLATFORM,43.6,-79.3',
      '247,247,BAY,43.6,-79.3',
    ].join('\n'),
  );
  assert.deepEqual(
    buildStops(rows, (row) => row.stop_name, only).map((stop) => stop.length),
    [6, 7],
  );
  assert.equal(buildStops(rows, (row) => row.stop_name, only)[1][6], 1);
});

test('the ZIP reader finds a deflated file in an archive', () => {
  const name = Buffer.from('stops.txt');
  const content = Buffer.from('stop_id\n1\n');
  const data = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  const entries = zipEntries(zip);
  assert.equal(entries.get('stops.txt')().toString(), 'stop_id\n1\n');
  assert.throws(() => zipEntries(Buffer.alloc(40)), /Not a ZIP/);
});
