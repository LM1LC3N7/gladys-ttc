// -----------------------------------------------------------------------------
// Minimal GTFS-Realtime decoder: the TripUpdates of a handful of stops, and
// the service alerts.
//
// The operator publishes its real-time predictions as a GTFS-Realtime feed, a
// Protocol Buffers message of a few megabytes covering every bus of the
// network. The usual way to read it (`gtfs-realtime-bindings`, built on
// protobufjs) materializes the WHOLE feed as JavaScript objects — tens of
// thousands of stop time updates — to then keep the three departures of the
// stop the user watches. In a container capped at 256 MB, that is the one
// allocation worth avoiding: measured on other Canadian feeds, decoding a 4 MB
// TripUpdates that way peaks well above 150 MB of RSS.
//
// So this module walks the wire format itself, and only builds an object for a
// stop time update whose stop_id is one of the watched stops. Everything else
// is skipped by length, without being decoded. It also keeps the integration
// free of any runtime dependency besides the Gladys SDK.
//
// Only the fields the integration reads are known here (field numbers from the
// official gtfs-realtime.proto, which is stable: fields are only ever added):
//
//   FeedMessage    header = 1, entity = 2
//   FeedHeader     timestamp = 3
//   FeedEntity     id = 1, is_deleted = 2, trip_update = 3, alert = 5
//   TripUpdate     trip = 1, stop_time_update = 2, timestamp = 4
//   TripDescriptor trip_id = 1, start_date = 3, schedule_relationship = 4,
//                  route_id = 5, direction_id = 6, modified_trip = 7
//   ModifiedTripSelector affected_trip_id = 2
//   StopTimeUpdate stop_sequence = 1, arrival = 2, departure = 3, stop_id = 4,
//                  schedule_relationship = 5
//   StopTimeEvent  delay = 1, time = 2
//   Alert          active_period = 1, informed_entity = 5, cause = 6,
//                  effect = 7, header_text = 10, description_text = 11,
//                  severity_level = 14
//   TimeRange      start = 1, end = 2
//   EntitySelector agency_id = 1, route_id = 2, route_type = 3, stop_id = 5
//   TranslatedString translation = 1;  Translation text = 1, language = 2
//
// Unknown fields — extensions included — are skipped, as protobuf requires.
// -----------------------------------------------------------------------------

/** TripDescriptor.ScheduleRelationship values the integration acts upon. */
export const TRIP_SCHEDULE_RELATIONSHIP = { SCHEDULED: 0, ADDED: 1, UNSCHEDULED: 2, CANCELED: 3 };

/** StopTimeUpdate.ScheduleRelationship values the integration acts upon. */
export const STOP_SCHEDULE_RELATIONSHIP = { SCHEDULED: 0, SKIPPED: 1, NO_DATA: 2 };

const WIRE = { VARINT: 0, FIXED64: 1, LENGTH_DELIMITED: 2, FIXED32: 5 };

/** Alert.Effect values. */
export const ALERT_EFFECT = {
  NO_SERVICE: 1,
  REDUCED_SERVICE: 2,
  SIGNIFICANT_DELAYS: 3,
  DETOUR: 4,
  ADDITIONAL_SERVICE: 5,
  MODIFIED_SERVICE: 6,
  OTHER_EFFECT: 7,
  UNKNOWN_EFFECT: 8,
  STOP_MOVED: 9,
  NO_EFFECT: 10,
  ACCESSIBILITY_ISSUE: 11,
};

/** Alert.SeverityLevel values. */
export const ALERT_SEVERITY = { UNKNOWN: 1, INFO: 2, WARNING: 3, SEVERE: 4 };

/** Thrown when the payload is not a well-formed protobuf message. */
export class GtfsRealtimeDecodeError extends Error {
  constructor(message) {
    super(`Malformed GTFS-Realtime feed: ${message}`);
    this.name = 'GtfsRealtimeDecodeError';
  }
}

/**
 * A cursor over one protobuf message (a slice of the feed buffer). Reading a
 * nested message only creates a new cursor over the same buffer: no copy.
 */
class Reader {
  /**
   * @param {Uint8Array} buffer
   * @param {number} start
   * @param {number} end
   */
  constructor(buffer, start = 0, end = buffer.length) {
    this.buffer = buffer;
    this.pos = start;
    this.end = end;
  }

  done() {
    return this.pos >= this.end;
  }

  /**
   * A varint, as a Number. The values of this feed (POSIX times, sequences,
   * enums, small delays) all fit in 2^53; a negative int32 (a train running
   * early) is encoded on ten bytes as a 64-bit two's complement, and is the one
   * case that needs BigInt to come back signed — see `readSignedVarint`.
   */
  readVarint() {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < 10; i += 1) {
      if (this.pos >= this.end) {
        throw new GtfsRealtimeDecodeError('truncated varint');
      }
      const byte = this.buffer[this.pos];
      this.pos += 1;
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        return result;
      }
      multiplier *= 128;
    }
    throw new GtfsRealtimeDecodeError('varint longer than 10 bytes');
  }

  /** A varint read as a signed 64-bit integer (protobuf int32 / int64). */
  readSignedVarint() {
    const start = this.pos;
    const unsigned = this.readVarint();
    if (unsigned <= Number.MAX_SAFE_INTEGER) {
      return unsigned;
    }
    // Re-read the bytes exactly: the Number accumulation above has lost the
    // low bits of a value this large.
    let value = 0n;
    let shift = 0n;
    for (let pos = start; pos < this.pos; pos += 1) {
      value |= BigInt(this.buffer[pos] & 0x7f) << shift;
      shift += 7n;
    }
    return Number(BigInt.asIntN(64, value));
  }

  /** The bounds of a length-delimited field, which the cursor then skips. */
  readLengthDelimited() {
    const length = this.readVarint();
    const start = this.pos;
    const end = start + length;
    if (end > this.end) {
      throw new GtfsRealtimeDecodeError('length-delimited field past the end of its message');
    }
    this.pos = end;
    return { start, end };
  }

  readString() {
    const { start, end } = this.readLengthDelimited();
    return textDecoder.decode(this.buffer.subarray(start, end));
  }

  readMessage() {
    const { start, end } = this.readLengthDelimited();
    return new Reader(this.buffer, start, end);
  }

  /** The next field tag: `{ field, wire }`. */
  readTag() {
    const tag = this.readVarint();
    return { field: Math.floor(tag / 8), wire: tag % 8 };
  }

  /** Skip the value of a field the decoder does not read. */
  skip(wire) {
    switch (wire) {
      case WIRE.VARINT:
        this.readVarint();
        return;
      case WIRE.FIXED64:
        this.advance(8);
        return;
      case WIRE.LENGTH_DELIMITED:
        this.readLengthDelimited();
        return;
      case WIRE.FIXED32:
        this.advance(4);
        return;
      default:
        // Groups (3, 4) are long deprecated and absent from gtfs-realtime.proto.
        throw new GtfsRealtimeDecodeError(`unsupported wire type ${wire}`);
    }
  }

  advance(bytes) {
    if (this.pos + bytes > this.end) {
      throw new GtfsRealtimeDecodeError('fixed-size field past the end of its message');
    }
    this.pos += bytes;
  }
}

const textDecoder = new TextDecoder('utf-8');

/**
 * Iterate over the fields of a message, handing each tag to `onField`, which
 * reads the value itself or returns false to have it skipped.
 *
 * @param {Reader} reader
 * @param {(field: number, wire: number) => boolean | void} onField
 */
function forEachField(reader, onField) {
  while (!reader.done()) {
    const { field, wire } = reader.readTag();
    if (onField(field, wire) === false) {
      reader.skip(wire);
    }
  }
}

/** StopTimeEvent -> `{ time, delay }`, either possibly undefined. */
function readStopTimeEvent(reader) {
  const event = {};
  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.VARINT) {
      event.delay = reader.readSignedVarint();
    } else if (field === 2 && wire === WIRE.VARINT) {
      event.time = reader.readSignedVarint();
    } else {
      return false;
    }
    return true;
  });
  return event;
}

/**
 * The stop_id of a StopTimeUpdate, read without decoding anything else: this
 * is the filter every update of the feed goes through, so it must be cheap.
 */
function peekStopId(reader) {
  const probe = new Reader(reader.buffer, reader.pos, reader.end);
  let stopId;
  forEachField(probe, (field, wire) => {
    if (field === 4 && wire === WIRE.LENGTH_DELIMITED) {
      stopId = probe.readString();
      return true;
    }
    return false;
  });
  return stopId;
}

/** A whole StopTimeUpdate, for a stop the caller watches. */
function readStopTimeUpdate(reader) {
  const update = { scheduleRelationship: STOP_SCHEDULE_RELATIONSHIP.SCHEDULED };
  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.VARINT) {
      update.stopSequence = reader.readVarint();
    } else if (field === 2 && wire === WIRE.LENGTH_DELIMITED) {
      update.arrival = readStopTimeEvent(reader.readMessage());
    } else if (field === 3 && wire === WIRE.LENGTH_DELIMITED) {
      update.departure = readStopTimeEvent(reader.readMessage());
    } else if (field === 4 && wire === WIRE.LENGTH_DELIMITED) {
      update.stopId = reader.readString();
    } else if (field === 5 && wire === WIRE.VARINT) {
      update.scheduleRelationship = reader.readVarint();
    } else {
      return false;
    }
    return true;
  });
  return update;
}

/** TripDescriptor -> the fields the departures board needs. */
function readTripDescriptor(reader) {
  const trip = { scheduleRelationship: TRIP_SCHEDULE_RELATIONSHIP.SCHEDULED };
  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.LENGTH_DELIMITED) {
      trip.tripId = reader.readString();
    } else if (field === 3 && wire === WIRE.LENGTH_DELIMITED) {
      trip.startDate = reader.readString();
    } else if (field === 4 && wire === WIRE.VARINT) {
      trip.scheduleRelationship = reader.readVarint();
    } else if (field === 5 && wire === WIRE.LENGTH_DELIMITED) {
      trip.routeId = reader.readString();
    } else if (field === 6 && wire === WIRE.VARINT) {
      trip.directionId = reader.readVarint();
    } else if (field === 7 && wire === WIRE.LENGTH_DELIMITED) {
      // A trip on a detour (trip modifications, ETS) is named by the trip it
      // modifies, without a trip_id of its own.
      const selector = reader.readMessage();
      forEachField(selector, (selectorField, selectorWire) => {
        if (selectorField === 2 && selectorWire === WIRE.LENGTH_DELIMITED) {
          trip.affectedTripId = selector.readString();
          return true;
        }
        return false;
      });
    } else {
      return false;
    }
    return true;
  });
  return trip;
}

/**
 * One TripUpdate: its trip, and the updates of the watched stops only. The
 * trip descriptor may come after the stop time updates on the wire (protobuf
 * does not order fields), so the matching updates are collected first and
 * paired with the trip at the end.
 */
function readTripUpdate(reader, stopIds) {
  let trip;
  const updates = [];
  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.LENGTH_DELIMITED) {
      trip = readTripDescriptor(reader.readMessage());
      return true;
    }
    if (field === 2 && wire === WIRE.LENGTH_DELIMITED) {
      const message = reader.readMessage();
      const stopId = peekStopId(message);
      if (stopId !== undefined && stopIds.has(stopId)) {
        updates.push(readStopTimeUpdate(message));
      }
      return true;
    }
    return false;
  });
  return { trip: trip ?? { scheduleRelationship: TRIP_SCHEDULE_RELATIONSHIP.SCHEDULED }, updates };
}

/** FeedEntity -> its trip update, when it carries one that matters. */
function readEntity(reader, stopIds) {
  let deleted = false;
  let tripUpdate = null;
  forEachField(reader, (field, wire) => {
    if (field === 2 && wire === WIRE.VARINT) {
      deleted = reader.readVarint() === 1;
      return true;
    }
    if (field === 3 && wire === WIRE.LENGTH_DELIMITED) {
      tripUpdate = readTripUpdate(reader.readMessage(), stopIds);
      return true;
    }
    return false;
  });
  return deleted ? null : tripUpdate;
}

/**
 * Decode the stop time updates of the watched stops out of a TripUpdates feed.
 *
 * @param {Uint8Array} buffer the raw protobuf payload
 * @param {Iterable<string>} watchedStopIds GTFS stop_id values
 * @returns {{
 *   timestamp: number | undefined,
 *   stopTimes: {
 *     stopId: string, routeId: string | undefined, tripId: string | undefined,
 *     directionId: number | undefined, tripScheduleRelationship: number,
 *     scheduleRelationship: number, stopSequence: number | undefined,
 *     arrival: { time?: number, delay?: number } | undefined,
 *     departure: { time?: number, delay?: number } | undefined,
 *   }[],
 * }} the feed timestamp (POSIX seconds) and the matching stop times
 */
export function decodeTripUpdates(buffer, watchedStopIds) {
  const stopIds = new Set(watchedStopIds);
  const reader = new Reader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  let timestamp;
  const stopTimes = [];

  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.LENGTH_DELIMITED) {
      const header = reader.readMessage();
      forEachField(header, (headerField, headerWire) => {
        if (headerField === 3 && headerWire === WIRE.VARINT) {
          timestamp = header.readVarint();
          return true;
        }
        return false;
      });
      return true;
    }
    if (field === 2 && wire === WIRE.LENGTH_DELIMITED) {
      // An empty watch list still walks the entities, for the header and the
      // well-formedness check: the connection test relies on it.
      const tripUpdate = readEntity(reader.readMessage(), stopIds);
      for (const update of tripUpdate?.updates ?? []) {
        stopTimes.push({
          stopId: update.stopId,
          routeId: tripUpdate.trip.routeId,
          tripId: tripUpdate.trip.tripId ?? tripUpdate.trip.affectedTripId,
          directionId: tripUpdate.trip.directionId,
          tripScheduleRelationship: tripUpdate.trip.scheduleRelationship,
          scheduleRelationship: update.scheduleRelationship,
          stopSequence: update.stopSequence,
          arrival: update.arrival,
          departure: update.departure,
        });
      }
      return true;
    }
    return false;
  });

  return { timestamp, stopTimes };
}

// --- Service alerts ------------------------------------------------------------

/** TranslatedString -> `[{ text, language }]`. */
function readTranslatedString(reader) {
  const translations = [];
  forEachField(reader, (field, wire) => {
    if (field !== 1 || wire !== WIRE.LENGTH_DELIMITED) return false;
    const translation = reader.readMessage();
    const entry = { text: '', language: undefined };
    forEachField(translation, (subField, subWire) => {
      if (subField === 1 && subWire === WIRE.LENGTH_DELIMITED) {
        entry.text = translation.readString();
      } else if (subField === 2 && subWire === WIRE.LENGTH_DELIMITED) {
        entry.language = translation.readString();
      } else {
        return false;
      }
      return true;
    });
    translations.push(entry);
    return true;
  });
  return translations;
}

/** EntitySelector -> the fields that say what an alert is about. */
function readEntitySelector(reader) {
  const entity = {};
  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.LENGTH_DELIMITED) {
      entity.agencyId = reader.readString();
    } else if (field === 2 && wire === WIRE.LENGTH_DELIMITED) {
      entity.routeId = reader.readString();
    } else if (field === 3 && wire === WIRE.VARINT) {
      entity.routeType = reader.readSignedVarint();
    } else if (field === 5 && wire === WIRE.LENGTH_DELIMITED) {
      entity.stopId = reader.readString();
    } else {
      return false;
    }
    return true;
  });
  return entity;
}

/** TimeRange -> `{ start, end }`, either possibly undefined (open bound). */
function readTimeRange(reader) {
  const range = {};
  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.VARINT) {
      range.start = reader.readVarint();
    } else if (field === 2 && wire === WIRE.VARINT) {
      range.end = reader.readVarint();
    } else {
      return false;
    }
    return true;
  });
  return range;
}

/** Alert -> a plain object. */
function readAlert(reader) {
  const alert = {
    activePeriods: [],
    informedEntities: [],
    cause: undefined,
    effect: undefined,
    severity: undefined,
    headerText: [],
    descriptionText: [],
  };
  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.LENGTH_DELIMITED) {
      alert.activePeriods.push(readTimeRange(reader.readMessage()));
    } else if (field === 5 && wire === WIRE.LENGTH_DELIMITED) {
      alert.informedEntities.push(readEntitySelector(reader.readMessage()));
    } else if (field === 6 && wire === WIRE.VARINT) {
      alert.cause = reader.readVarint();
    } else if (field === 7 && wire === WIRE.VARINT) {
      alert.effect = reader.readVarint();
    } else if (field === 10 && wire === WIRE.LENGTH_DELIMITED) {
      alert.headerText = readTranslatedString(reader.readMessage());
    } else if (field === 11 && wire === WIRE.LENGTH_DELIMITED) {
      alert.descriptionText = readTranslatedString(reader.readMessage());
    } else if (field === 14 && wire === WIRE.VARINT) {
      alert.severity = reader.readVarint();
    } else {
      return false;
    }
    return true;
  });
  return alert;
}

/**
 * Decode every alert of a service alerts feed. An alerts feed is small (a few
 * dozen alerts for a whole network): everything is materialized.
 *
 * @param {Uint8Array} buffer the raw protobuf payload
 * @returns {{ timestamp: number | undefined, alerts: (ReturnType<typeof readAlert> & { id?: string })[] }}
 */
export function decodeAlerts(buffer) {
  const reader = new Reader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  let timestamp;
  const alerts = [];
  forEachField(reader, (field, wire) => {
    if (field === 1 && wire === WIRE.LENGTH_DELIMITED) {
      const header = reader.readMessage();
      forEachField(header, (headerField, headerWire) => {
        if (headerField === 3 && headerWire === WIRE.VARINT) {
          timestamp = header.readVarint();
          return true;
        }
        return false;
      });
      return true;
    }
    if (field === 2 && wire === WIRE.LENGTH_DELIMITED) {
      const entity = reader.readMessage();
      let id;
      let deleted = false;
      let alert = null;
      forEachField(entity, (entityField, entityWire) => {
        if (entityField === 1 && entityWire === WIRE.LENGTH_DELIMITED) {
          id = entity.readString();
        } else if (entityField === 2 && entityWire === WIRE.VARINT) {
          deleted = entity.readVarint() === 1;
        } else if (entityField === 5 && entityWire === WIRE.LENGTH_DELIMITED) {
          alert = readAlert(entity.readMessage());
        } else {
          return false;
        }
        return true;
      });
      if (alert && !deleted) alerts.push({ id, ...alert });
      return true;
    }
    return false;
  });
  return { timestamp, alerts };
}
