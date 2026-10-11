// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys >= 5.1.0).
//
// An operation a scene author places in a scene, whose outputs the following
// actions can read — "when I leave home, tell me when the next 99 comes", "at
// 7:30, send me the status of the Expo Line". Each one does a FRESH read:
// a scene runs at a moment the author chose, and handing it the reading of the
// last poll (up to an interval old) would answer a question nobody asked.
//
// Throwing fails this action only: the scene logs it and continues. An empty
// board is not a failure, it is an answer (count = 0).
// -----------------------------------------------------------------------------

import { findSelectedBlueprint, linesBlueprint } from '../devices/index.js';
import { DEVICE_TYPE as STOP_TYPE, formatSummary } from '../devices/stop.js';
import { STATUS_LABELS } from '../devices/lineStatus.js';
import { recordReading } from '../devices/readings.js';
import { normalizeRoute } from '../api/stops.js';
import { NETWORK } from '../network.js';

/** Keys of the `scene_actions` declared in the manifest. Never rename one. */
export const SCENE_ACTION_KEYS = {
  GET_NEXT_DEPARTURES: 'get_next_departures',
  GET_LINE_STATUS: 'get_line_status',
};

/** Turn a DeviceSelectionError into a plain error the scene log can show. */
function rethrowReadable(err) {
  if (err?.userMessage) {
    throw new Error(err.userMessage.en);
  }
  throw err;
}

const RAW_SCENE_ACTIONS = {
  async [SCENE_ACTION_KEYS.GET_NEXT_DEPARTURES](gladys, { fields, config }) {
    let blueprint;
    try {
      blueprint = findSelectedBlueprint(gladys, fields.stop, config, STOP_TYPE);
    } catch (err) {
      rethrowReadable(err);
    }
    const all = await blueprint.read(config);
    recordReading(blueprint.key, all);
    const route = normalizeRoute(fields.route);
    const departures = route
      ? all.filter((departure) => normalizeRoute(departure.route) === route)
      : all;
    const [next, following] = departures;
    return {
      route: next?.route ?? '',
      minutes: next?.minutes ?? null,
      following_minutes: following?.minutes ?? null,
      summary: formatSummary(departures.slice(0, config.max_departures), config.language),
      count: departures.length,
    };
  },

  async [SCENE_ACTION_KEYS.GET_LINE_STATUS](gladys, { fields, config }) {
    let blueprint;
    try {
      blueprint = linesBlueprint(config);
    } catch (err) {
      rethrowReadable(err);
    }
    const status = await blueprint.read(config);
    recordReading(blueprint.key, status);
    const line = status.lines.find((candidate) => candidate.id === String(fields.line ?? ''));
    if (!line) {
      throw new Error(`Unknown line "${fields.line}"`);
    }
    return {
      line_name: line.name[config.language],
      status: line.status,
      status_label: STATUS_LABELS[line.status][config.language],
      message: line.message,
      normal: line.status === 'normal',
    };
  },
};

/** The scene actions of the features this network has: no line, no line action. */
export const SCENE_ACTIONS = Object.fromEntries(
  Object.entries(RAW_SCENE_ACTIONS).filter(
    ([key]) => key !== SCENE_ACTION_KEYS.GET_LINE_STATUS || NETWORK.lines.length > 0,
  ),
);
