// -----------------------------------------------------------------------------
// Entry point of the Gladys transit integration (the network: src/network.js).
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It
// holds no transit logic: reading the APIs lives in src/api/, and turning a
// reading into features lives in src/devices/. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects and publishes the discovered devices.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { NETWORK } from './src/network.js';
import { describeStatus } from './src/status.js';
import { refreshSuggestions } from './src/devices/suggestions.js';
import {
  ACTIONS,
  buildDiscoveredDevices,
  pollDevice,
  refreshDeviceNow,
} from './src/devices/index.js';
import { clearPollSchedule } from './src/devices/pollSchedule.js';
import { clearStateCache } from './src/devices/stateCache.js';
import { clearPublishReports } from './src/devices/publish.js';
import { clearReadings } from './src/devices/readings.js';
import { startRefreshLoop, stopRefreshLoop } from './src/devices/refreshLoop.js';
import { clearRealtimeCache } from './src/api/realtime.js';
import { clearBikeCache } from './src/api/bikes.js';
import { clearSceneMemory } from './src/scenes/triggers.js';
import { SCENE_ACTIONS } from './src/scenes/actions.js';
import { WIDGETS } from './src/widgets/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
// A scan is the user asking "what is there?": look around the house again
// before answering.
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> looking around the house, then publishing the devices');
  await refreshSuggestions(gladys, config);
  await publishDevices();
  await reportConnectionStatus();
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// The core scheduler ticks at the `poll_frequency` the device was published
// with (one minute at the slowest); `pollDevice` routes the tick to the right
// blueprint and drops the ones inside the configured refresh interval. The
// container also ticks on its own (src/devices/refreshLoop.js); both paths go
// through the same gate, so each source is read once per interval.
gladys.onPoll(async (device) => {
  await pollDevice(gladys, device, config);
});

// --- A device was just created, or updated from the Discovery screen --------
// Gladys dropped the states sent before the feature existed: read it now
// rather than after whatever remains of the refresh interval.
const refreshAddedDevice = (event) => async (device) => {
  try {
    await refreshDeviceNow(gladys, device, config);
  } catch (err) {
    logger.warn(`Reading ${device?.external_id} after it was ${event} failed: ${err.message}`);
  }
};
// The status line counts the devices still waiting in the Discovery screen:
// it changes with every device the user adds.
const afterDeviceChange = (event) => async (device) => {
  await refreshAddedDevice(event)(device);
  await reportConnectionStatus().catch((err) =>
    logger.warn(`Connection status not updated: ${err.message}`),
  );
};
gladys.onDeviceCreated(afterDeviceChange('created'));
gladys.onDeviceUpdated(afterDeviceChange('updated'));

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const [actionKey, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(actionKey, (fields) => handler(gladys, { fields: fields ?? {}, config }));
}

// --- Scene actions (Gladys >= 5.1) -------------------------------------------
// The scene TRIGGERS need no handler: they are fired from the poll path (see
// src/scenes/triggers.js).
for (const [actionKey, handler] of Object.entries(SCENE_ACTIONS)) {
  gladys.onSceneAction(actionKey, (fields) => handler(gladys, { fields: fields ?? {}, config }));
}

// --- Dashboard widgets (Gladys >= 5.1) ---------------------------------------
for (const [widgetKey, handler] of Object.entries(WIDGETS)) {
  gladys.onWidgetGet(widgetKey, ({ settings }) =>
    handler(gladys, { settings: settings ?? {}, config }),
  );
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // The key or the watch lists may have changed: anything cached or
  // remembered under the previous configuration is now suspect.
  clearRealtimeCache();
  clearBikeCache();
  clearPollSchedule();
  clearReadings();
  clearStateCache();
  clearPublishReports();
  clearSceneMemory();
  // The house, the number of suggestions or the key (names) may have changed.
  await refreshSuggestions(gladys, config);
  await publishDevices();
  await reportConnectionStatus();
  startRefreshLoop(gladys, () => config);
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // A (re)connection may be another Gladys: publish everything once, then
    // only the changes (see src/devices/stateCache.js).
    clearStateCache();
    clearPublishReports();

    // 2) Refresh the devices the user already created, now and at every tick.
    // It comes before the publication on purpose: a publication that fails
    // must not leave the existing devices without anything refreshing them.
    startRefreshLoop(gladys, () => config);

    // 3) Look the stops and stations near the house up, and (re)publish every
    // device: typed, suggested, and already created.
    await refreshSuggestions(gladys, config);
    await publishDevices();

    // 4) Report the application-level status, shown in the Configuration
    // screen.
    await reportConnectionStatus();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// Reading the APIs while Gladys is unreachable would only throw the result
// away — and spend the operator's API for nothing.
gladys.on('disconnected', () => {
  stopRefreshLoop();
});

/** Publish the devices described by the current configuration, by name. */
async function publishDevices() {
  const devices = buildDiscoveredDevices(gladys, config);
  logger.info(
    devices.length === 0
      ? 'No device to publish: nothing is watched in the configuration'
      : `Publishing ${devices.length} device(s): ${devices.map((device) => device.name).join(', ')}`,
  );
  await gladys.publishDiscoveredDevices(devices);
}

/**
 * Tell Gladys what the integration is doing and, above all, what the user has
 * to do next (see src/status.js): for a non-technical user, this line is the
 * user interface.
 */
async function reportConnectionStatus() {
  const { connected, message } = describeStatus(gladys, config);
  await gladys.setConnectionStatus(connected, message);
}

// --- Safety net for a forgotten promise --------------------------------------
// A promise that slips through one day would, by Node's default, kill the
// container — and every device with it. Log it and keep running: the next tick
// reads again. An uncaught EXCEPTION is left alone on purpose: the process
// state is then unknown, and restarting is the right call.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshLoop();
});

// --- Startup -----------------------------------------------------------------
logger.info(`Starting the ${NETWORK.operator} integration...`);
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
