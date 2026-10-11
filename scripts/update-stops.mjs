// -----------------------------------------------------------------------------
// Regenerate gtfs/stops.json and gtfs/routes.json from the operator's static
// GTFS (`npm run update-stops`).
//
// Why a table shipped with the image rather than a lookup at run time: the
// number riders know is the stop CODE written on the sign ("Stop #50040"),
// while every feed — the real-time one, Transitous — speaks GTFS stop_id, an
// internal number. Nothing keyless answers "which stop_id is code 50040", and
// the static GTFS is a 16 to 70 MB archive: too much to download in a 256 MB
// container to read a 2 MB file out of it. The table also makes the stop
// search and the "near my home" suggestions instant and free of any request.
//
// Stop ids and codes are stable across the operator's schedule changes; run
// this script before a release when the operator adds stops (a code missing
// from the table is reported to the user as unknown).
//
// No dependency: the archive is read with a minimal ZIP reader (central
// directory + raw inflate, both in node:zlib's reach) and a CSV parser that
// handles the quoted fields of GTFS.
// -----------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { NETWORK } from '../src/network.js';

/**
 * The files of a ZIP archive, by name, read on demand.
 * @param {Buffer} zip
 * @returns {Map<string, () => Buffer>}
 */
export function zipEntries(zip) {
  // The End Of Central Directory record closes the archive; a comment (up to
  // 64 KB) may follow it, hence the backward scan.
  let eocd = -1;
  for (let pos = zip.length - 22; pos >= Math.max(0, zip.length - 22 - 65_535); pos -= 1) {
    if (zip.readUInt32LE(pos) === 0x06054b50) {
      eocd = pos;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a ZIP archive (no end of central directory)');
  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = zip.readUInt16LE(pos + 10);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLength);
    entries.set(name, () => {
      const dataStart =
        localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${name}: unsupported ZIP compression method ${method}`);
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Rows of a CSV file as objects keyed by the header. Handles quoted fields,
 * doubled quotes and a UTF-8 byte order mark.
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  const [header = [], ...data] = rows;
  const keys = header.map((key) => key.trim());
  return data.map((values) =>
    Object.fromEntries(keys.map((key, index) => [key, (values[index] ?? '').trim()])),
  );
}

/**
 * The route label riders use: the short name without its leading zeros
 * (TransLink publishes "099" for the 99), else the long name ("Canada Line").
 * @param {Record<string, string>} route
 */
export function routeLabel(route) {
  const short = (route.route_short_name ?? '').replace(/^0+(?=.)/, '');
  return short || route.route_long_name || route.route_id;
}

/**
 * The stop table: one entry per stop code.
 *
 * A code may cover several GTFS stops: the platforms of a station share the
 * station's code at OC Transpo, and a station row (location_type 1) stands
 * for its platforms. `ids` lists every stop_id the real-time feed may use for
 * the code; `query` the ids to ask Transitous (the station when there is
 * one: Transitous answers for a station with the departures of its platforms).
 *
 * A 7th element, 1, marks a code whose every stop_id is in `scheduleOnly`:
 * the real-time feed leaves it out, its departures are the timetable.
 *
 * @param {Record<string, string>[]} rows of stops.txt
 * @param {(row: Record<string, string>) => string} stopName
 * @param {Set<string>} [scheduleOnly] stop_ids the real-time feed leaves out
 * @returns {([string, string, number, number, string[], string[]] |
 *   [string, string, number, number, string[], string[], 1])[]}
 *   [code, name, lat, lon, ids, query, scheduleOnly?]
 */
export function buildStops(rows, stopName, scheduleOnly = new Set()) {
  const byCode = new Map();
  const children = new Map();
  for (const row of rows) {
    // A station stands for its platforms (location_type 0), not for its
    // entrances (2): only a platform has departures.
    if (row.parent_station && ['', '0'].includes(row.location_type ?? '')) {
      const list = children.get(row.parent_station) ?? [];
      list.push(row.stop_id);
      children.set(row.parent_station, list);
    }
    // Entrances, generic nodes and boarding areas have no departures.
    if (!row.stop_code || !['', '0', '1'].includes(row.location_type ?? '')) continue;
    const list = byCode.get(row.stop_code) ?? [];
    list.push(row);
    byCode.set(row.stop_code, list);
  }
  const stops = [];
  for (const [code, group] of byCode) {
    const station = group.find((row) => row.location_type === '1');
    const main = station ?? group[0];
    const ids = new Set(group.map((row) => row.stop_id));
    if (station) {
      for (const child of children.get(station.stop_id) ?? []) ids.add(child);
    }
    const parents = new Set(group.map((row) => row.parent_station || row.stop_id));
    const query = station
      ? [station.stop_id]
      : parents.size === 1 && group.length > 1
        ? [...parents]
        : group.map((row) => row.stop_id);
    const entry = [
      code,
      stopName(main),
      Number(Number(main.stop_lat).toFixed(6)),
      Number(Number(main.stop_lon).toFixed(6)),
      [...ids],
      query,
    ];
    if ([...ids].every((id) => scheduleOnly.has(id))) entry.push(1);
    stops.push(entry);
  }
  return stops.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
}

/**
 * The route table: route_id → label, plus the short name → label when no
 * route_id takes it. Calgary Transit versions its route_ids ("201-20786",
 * "201-20801" are the Red Line of two service periods) while its real-time
 * feeds name the route by its short name ("201").
 * @param {Record<string, string>[]} rows routes.txt
 * @returns {Record<string, string>}
 */
export function buildRoutes(rows) {
  const routes = new Map(rows.map((route) => [route.route_id, routeLabel(route)]));
  for (const route of rows) {
    const short = route.route_short_name ?? '';
    if (short && !routes.has(short)) routes.set(short, routeLabel(route));
  }
  return Object.fromEntries(
    [...routes].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
  );
}

/**
 * The stop_ids served by the trips of some routes. stop_times.txt is the big
 * file of a GTFS (200 MB at the TTC): it is scanned line by line rather than
 * parsed into objects, which would take gigabytes. Its fields are never
 * quoted in practice; a quoted line would only be missed, not misread.
 *
 * @param {string} trips the text of trips.txt
 * @param {string} stopTimes the text of stop_times.txt
 * @param {string[]} routeIds
 * @returns {Set<string>}
 */
export function stopsServedOnlyBy(trips, stopTimes, routeIds) {
  const routes = new Set(routeIds);
  const tripRoute = new Map(parseCsv(trips).map((trip) => [trip.trip_id, trip.route_id]));
  const lines = stopTimes.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = lines[0].split(',').map((key) => key.trim());
  const tripColumn = header.indexOf('trip_id');
  const stopColumn = header.indexOf('stop_id');
  const inside = new Set();
  const outside = new Set();
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const fields = lines[i].split(',');
    const stop = fields[stopColumn];
    (routes.has(tripRoute.get(fields[tripColumn])) ? inside : outside).add(stop);
  }
  return new Set([...inside].filter((stop) => !outside.has(stop)));
}

async function main() {
  const { url, stopName } = NETWORK.gtfs;
  console.log(`Downloading ${url}…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const entries = zipEntries(Buffer.from(await response.arrayBuffer()));
  const read = (name) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`${name} missing from the archive`);
    return parseCsv(entry().toString('utf8'));
  };

  const generated = new Date().toISOString().slice(0, 10);
  const scheduleOnly = NETWORK.gtfs.scheduleOnlyRoutes
    ? stopsServedOnlyBy(
        entries.get('trips.txt')().toString('utf8'),
        entries.get('stop_times.txt')().toString('utf8'),
        NETWORK.gtfs.scheduleOnlyRoutes,
      )
    : new Set();
  // A regional feed (ETS) also lists the stops of its neighbours: only the
  // operator's own are kept.
  const keepStop = NETWORK.gtfs.keepStop ?? (() => true);
  const stops = buildStops(read('stops.txt').filter(keepStop), stopName, scheduleOnly);
  const routes = buildRoutes(read('routes.txt'));

  mkdirSync('gtfs', { recursive: true });
  // One stop per line: the diff of a regeneration then reads stop by stop.
  writeFileSync(
    'gtfs/stops.json',
    `{"generated":"${generated}","source":${JSON.stringify(url)},"stops":[\n` +
      stops.map((stop) => JSON.stringify(stop)).join(',\n') +
      '\n]}\n',
  );
  writeFileSync(
    'gtfs/routes.json',
    `${JSON.stringify({ generated, source: url, routes }, null, 1)}\n`,
  );
  console.log(
    `${stops.length} stop codes (${stops.filter((stop) => stop[6]).length} timetable only), ` +
      `${Object.keys(routes).length} routes written to gtfs/`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
