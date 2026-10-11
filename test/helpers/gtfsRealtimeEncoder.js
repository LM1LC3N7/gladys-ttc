// -----------------------------------------------------------------------------
// A tiny GTFS-Realtime ENCODER, for the tests only.
//
// The tests build their feeds from plain objects rather than shipping binary
// fixtures: a fixture says nothing about what it contains, while
// `encodeFeed({ entities: [...] })` reads as the scenario it is. The field
// numbers are the ones of gtfs-realtime.proto, the same as the decoder's; a
// cross-check against the official `gtfs-realtime-bindings` encoder was run by
// hand when the decoder was written (see CLAUDE.md).
// -----------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/** A varint, signed values as 64-bit two's complement (protobuf int32/int64). */
function varint(value) {
  let big = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    let byte = Number(big & 0x7fn);
    big >>= 7n;
    if (big > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (big > 0n);
  return bytes;
}

const tag = (field, wire) => varint(field * 8 + wire);

function varintField(field, value) {
  return value === undefined ? [] : [...tag(field, 0), ...varint(value)];
}

function bytesField(field, bytes) {
  return bytes === undefined ? [] : [...tag(field, 2), ...varint(bytes.length), ...bytes];
}

function stringField(field, value) {
  return value === undefined ? [] : bytesField(field, [...textEncoder.encode(value)]);
}

function stopTimeEvent(event) {
  if (!event) return undefined;
  return [...varintField(1, event.delay), ...varintField(2, event.time)];
}

function stopTimeUpdate(update) {
  return [
    ...varintField(1, update.stopSequence),
    ...bytesField(2, stopTimeEvent(update.arrival)),
    ...bytesField(3, stopTimeEvent(update.departure)),
    ...stringField(4, update.stopId),
    ...varintField(5, update.scheduleRelationship),
  ];
}

function tripDescriptor(trip) {
  return [
    ...stringField(1, trip.tripId),
    ...stringField(3, trip.startDate),
    ...varintField(4, trip.scheduleRelationship),
    ...stringField(5, trip.routeId),
    ...varintField(6, trip.directionId),
  ];
}

function tripUpdate(update, { tripLast = false } = {}) {
  const trip = bytesField(1, tripDescriptor(update.trip ?? {}));
  const stops = (update.stopTimeUpdates ?? []).flatMap((stu) => bytesField(2, stopTimeUpdate(stu)));
  // `tripLast` puts the trip descriptor after the stop time updates: protobuf
  // does not order fields, and the decoder must not assume it does.
  return tripLast ? [...stops, ...trip] : [...trip, ...stops];
}

function translatedString(texts) {
  if (!texts) return undefined;
  return texts.flatMap((entry) =>
    bytesField(1, [...stringField(1, entry.text), ...stringField(2, entry.language)]),
  );
}

function alert(value) {
  return [
    ...(value.activePeriods ?? []).flatMap((period) =>
      bytesField(1, [...varintField(1, period.start), ...varintField(2, period.end)]),
    ),
    ...(value.informedEntities ?? []).flatMap((selector) =>
      bytesField(5, [
        ...stringField(1, selector.agencyId),
        ...stringField(2, selector.routeId),
        ...varintField(3, selector.routeType),
        ...stringField(5, selector.stopId),
      ]),
    ),
    ...varintField(6, value.cause),
    ...varintField(7, value.effect),
    ...bytesField(10, translatedString(value.headerText)),
    ...bytesField(11, translatedString(value.descriptionText)),
    ...varintField(14, value.severity),
  ];
}

function entity(value) {
  return [
    ...stringField(1, value.id ?? 'entity'),
    ...varintField(2, value.isDeleted ? 1 : undefined),
    ...(value.tripUpdate
      ? bytesField(3, tripUpdate(value.tripUpdate, { tripLast: value.tripLast }))
      : []),
    ...(value.alert ? bytesField(5, alert(value.alert)) : []),
    // A field the decoder does not read (a vehicle position, field 4, holding
    // only its timestamp), which it must skip by length.
    ...(value.vehicle ? bytesField(4, varintField(5, value.vehicle.timestamp ?? 0)) : []),
  ];
}

/**
 * Encode a FeedMessage.
 *
 * @param {{ timestamp?: number, entities?: object[] }} feed
 * @returns {Uint8Array}
 */
export function encodeFeed({ timestamp, entities = [] } = {}) {
  const header = [...stringField(1, '2.0'), ...varintField(3, timestamp)];
  return Uint8Array.from([
    ...bytesField(1, header),
    ...entities.flatMap((value) => bytesField(2, entity(value))),
  ]);
}
