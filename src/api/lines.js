// -----------------------------------------------------------------------------
// The status of the rapid transit lines, from the operator's GTFS-Realtime
// service alerts (read with the user's key), or from its own alerts API
// translated to the same shape (`NETWORK.realtime.lineAlerts`).
//
// A service alerts feed lists what is wrong, not what is fine: a line no
// active alert names runs normally. An alert counts for a line when one of its
// informed entities names the line's route WITHOUT a stop — an alert naming a
// stop of the line is about that station (an elevator, an entrance, a bus
// bay), and a line running with one closed entrance is running. Accessibility
// alerts (elevators, escalators) are left out for the same reason.
//
// The status is read from the alert's effect: no service, reduced service and
// significant delays are a disruption; a detour, a modified service or any
// other effect is a notice worth showing, not an alarm.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { readFeed, readJson } from './realtime.js';
import { ALERT_EFFECT, ALERT_SEVERITY, decodeAlerts } from './gtfsRealtime.js';
import { NETWORK } from '../network.js';

const logger = createLogger({ name: 'lines' });

/** The lines of the device, from src/network.js. Never rename an id. */
export const LINES = NETWORK.lines;

/** What a line can be doing, from the integration's point of view. */
export const LINE_STATUS = {
  NORMAL: 'normal',
  DISRUPTED: 'disrupted',
  NOTICE: 'notice',
  UNKNOWN: 'unknown',
};

const DISRUPTING_EFFECTS = new Set([
  ALERT_EFFECT.NO_SERVICE,
  ALERT_EFFECT.REDUCED_SERVICE,
  ALERT_EFFECT.SIGNIFICANT_DELAYS,
]);

/**
 * The text of a translated field, in the wanted language, else in English,
 * else in any language at all (a feed may leave the language unset).
 *
 * @param {{ language?: string, text?: string }[] | undefined} texts
 * @param {string} language
 * @returns {string}
 */
export function pickText(texts, language) {
  const list = Array.isArray(texts) ? texts : [];
  const byLanguage = (lang) =>
    list.find((entry) => entry?.language?.toLowerCase().startsWith(lang) && entry.text)?.text;
  return String(
    byLanguage(language) ?? byLanguage('en') ?? list.find((entry) => entry?.text)?.text ?? '',
  ).trim();
}

/**
 * Whether an alert applies now. A missing bound is open, and no period at all
 * means "until removed from the feed".
 * @param {{ activePeriods?: { start?: number, end?: number }[] }} alert
 * @param {number} nowSeconds
 */
export function isActive(alert, nowSeconds) {
  const periods = alert?.activePeriods ?? [];
  if (periods.length === 0) return true;
  return periods.some(
    (period) =>
      (!period.start || period.start <= nowSeconds) && (!period.end || period.end >= nowSeconds),
  );
}

/**
 * The status an alert describes.
 * @param {{ effect?: number, severity?: number }} alert
 * @returns {string} a LINE_STATUS value
 */
export function classifyAlert(alert) {
  if (DISRUPTING_EFFECTS.has(alert?.effect) || alert?.severity === ALERT_SEVERITY.SEVERE) {
    return LINE_STATUS.DISRUPTED;
  }
  return LINE_STATUS.NOTICE;
}

// The worst status wins when a line has several alerts.
const SEVERITY = {
  [LINE_STATUS.UNKNOWN]: 0,
  [LINE_STATUS.NORMAL]: 1,
  [LINE_STATUS.NOTICE]: 2,
  [LINE_STATUS.DISRUPTED]: 3,
};

/**
 * The status of every line out of a decoded alerts feed.
 *
 * @param {{ timestamp?: number, alerts: object[] }} feed
 * @param {{ language: string, now?: number }} options
 * @returns {{ timestamp: number | undefined,
 *   lines: { id: string, name: { en: string, fr: string }, status: string, message: string }[] }}
 */
export function parseAlerts(feed, { language, now = Date.now() }) {
  const nowSeconds = Math.floor(now / 1000);
  const lines = new Map(
    LINES.map((line) => [line.id, { ...line, status: LINE_STATUS.NORMAL, messages: [] }]),
  );
  const lineOfRoute = new Map(LINES.flatMap((line) => line.routeIds.map((id) => [id, line.id])));

  for (const alert of feed?.alerts ?? []) {
    if (alert.effect === ALERT_EFFECT.ACCESSIBILITY_ISSUE) continue;
    if (alert.effect === ALERT_EFFECT.NO_EFFECT) continue;
    if (!isActive(alert, nowSeconds)) continue;
    const affected = new Set(
      (alert.informedEntities ?? [])
        .filter((entity) => entity.routeId && !entity.stopId)
        .map((entity) => lineOfRoute.get(entity.routeId))
        .filter(Boolean),
    );
    if (affected.size === 0) continue;
    const status = classifyAlert(alert);
    const message =
      pickText(alert.headerText, language) || pickText(alert.descriptionText, language);
    for (const id of affected) {
      const line = lines.get(id);
      if (SEVERITY[status] > SEVERITY[line.status]) line.status = status;
      if (message && !line.messages.some((entry) => entry.text === message)) {
        line.messages.push({ status, text: message });
      }
    }
  }

  const result = [...lines.values()].map(({ messages, routeIds: _routeIds, ...line }) => ({
    ...line,
    // The message shown is the one of the status retained.
    message: messages
      .filter((entry) => entry.status === line.status)
      .map((entry) => entry.text)
      .join(' '),
  }));
  return { timestamp: feed?.timestamp, lines: result };
}

/**
 * Read the current status of the lines.
 *
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {{ now?: number }} [options]
 */
export async function fetchLineStatus(config, { now = Date.now() } = {}) {
  // An operator whose GTFS-Realtime alerts cannot tell the lines apart (the
  // TTC) has its own alerts read and translated by src/network.js.
  const { lineAlerts } = NETWORK.realtime;
  const feed = lineAlerts
    ? lineAlerts.parse(await readJson(config, lineAlerts.url, 'Alerts'))
    : decodeAlerts(await readFeed(config, NETWORK.realtime.alertsUrl, 'Alerts'));
  // Calgary Transit writes the effect and the title of its alerts in HTML.
  const { tidyAlerts } = NETWORK.realtime;
  const status = parseAlerts(tidyAlerts ? tidyAlerts(feed) : feed, {
    language: config.language,
    now,
  });
  logger.debug(`Lines: ${status.lines.map((line) => `${line.id}=${line.status}`).join(', ')}`);
  return status;
}
