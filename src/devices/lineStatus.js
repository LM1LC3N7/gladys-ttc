// -----------------------------------------------------------------------------
// Device type: LINE STATUS
//
// One device for the rapid transit lines (NETWORK.lines), created when "Watch
// the lines" is on and an operator key is set. Read-only, refreshed at
// `lines_poll_frequency` from the operator's service alerts.
//
// Features, for each line:
//   - "<line> status"  : normal / disrupted / notice / unknown, as a short
//                        label in the configured language (text sensor) —
//                        what a scene condition or a dashboard tile compares;
//   - "<line> message" : the operator's alert, empty when the line runs
//                        normally (text sensor).
//
// The statuses keep an history: "how often was the line down this month" is a question the history answers, and a status changes a few times
// a day at most — the state cache only publishes the changes.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { TEXT_FEATURE_RANGE } from './featureRange.js';
import { changedStates } from './stateCache.js';
import { publishDeviceStates } from './publish.js';
import { fetchLineStatus, LINES, LINE_STATUS } from '../api/lines.js';
import { NETWORK } from '../network.js';

export const DEVICE_TYPE = 'transit-lines';
const PLATFORM_ID = 'network';

const logger = createLogger({ name: DEVICE_TYPE });

/** Feature key of a line's status label. */
export const statusFeatureKey = (lineId) => `line_${lineId}_status`;
/** Feature key of a line's message. */
export const messageFeatureKey = (lineId) => `line_${lineId}_message`;

/** The status labels, as published in the text features. */
export const STATUS_LABELS = {
  [LINE_STATUS.NORMAL]: { en: 'Normal', fr: 'Normal' },
  [LINE_STATUS.DISRUPTED]: { en: 'Disrupted', fr: 'Perturbé' },
  [LINE_STATUS.NOTICE]: { en: 'Notice', fr: 'Avis' },
  [LINE_STATUS.UNKNOWN]: { en: 'Unknown', fr: 'Inconnu' },
};

const LABELS = {
  en: {
    device: `${NETWORK.operator} – ${NETWORK.linesName.en}`,
    status: 'status',
    message: 'message',
  },
  fr: {
    device: `${NETWORK.operator} – ${NETWORK.linesName.fr}`,
    status: 'état',
    message: 'message',
  },
};

/** The blueprint of the line status device. */
export function createLineStatusBlueprint() {
  return {
    key: `${DEVICE_TYPE}:${PLATFORM_ID}`,
    type: DEVICE_TYPE,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, PLATFORM_ID).device;
    },

    pollIntervalMs(config) {
      return config.lines_poll_frequency * 1000;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
      const labels = LABELS[config.language];
      const features = LINES.flatMap((line) => [
        {
          name: `${line.name[config.language]} – ${labels.status}`,
          external_id: ids.feature(statusFeatureKey(line.id)),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          ...TEXT_FEATURE_RANGE,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: `${line.name[config.language]} – ${labels.message}`,
          external_id: ids.feature(messageFeatureKey(line.id)),
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          ...TEXT_FEATURE_RANGE,
          read_only: true,
          has_feedback: false,
          keep_history: false,
        },
      ]);

      return {
        name: labels.device,
        external_id: ids.device,
        poll_frequency: gladysPollFrequency(config.lines_poll_frequency),
        should_poll: true,
        features,
      };
    },

    /** The status of the lines (see src/api/lines.js). */
    read(config) {
      return fetchLineStatus(config);
    },

    async onPoll(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
      const status = await this.read(config);

      logger.info(`Lines: ${status.lines.map((line) => `${line.id}=${line.status}`).join(', ')}`);

      const states = status.lines.flatMap((line) => [
        {
          device_feature_external_id: ids.feature(statusFeatureKey(line.id)),
          text: STATUS_LABELS[line.status][config.language],
        },
        {
          device_feature_external_id: ids.feature(messageFeatureKey(line.id)),
          text: line.message,
        },
      ]);

      const updates = changedStates(states);
      if (updates.length > 0) {
        await publishDeviceStates(gladys, ids.device, updates);
      }
      return status;
    },
  };
}
