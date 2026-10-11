// -----------------------------------------------------------------------------
// The connection status shown in the Configuration screen of the integration.
//
// For somebody who is not technical, this line IS the user interface: it is
// the one place Gladys shows what the integration is doing. So it never says
// "connected" and stops there — it says what the user has to do next, in the
// order they have to do it:
//   1. nothing to show yet: locate the house in Gladys, or type a stop code;
//   2. devices waiting: open the Discovery tab and press "Add";
//   3. everything added: what is watched, and what an operator key would add.
//
// Each message fits in a couple of lines of the Configuration screen.
// -----------------------------------------------------------------------------

import { buildDiscoveredDevices } from './devices/index.js';
import { DEVICE_TYPE as STOP_TYPE } from './devices/stop.js';
import { DEVICE_TYPE as BIKE_TYPE } from './devices/bikeStation.js';
import { DEVICE_TYPE as LINES_TYPE } from './devices/lineStatus.js';
import { getSuggestions } from './devices/suggestions.js';
import { departuresSource, estimatedDailyRequests, hasApiKey, hasRealtime } from './config.js';
import { NETWORK } from './network.js';

const BIKE_SHARE = NETWORK.bike?.name ?? '';
const KEY = NETWORK.realtime?.keyLabel;

/** The kind of a discovered device, from its external id (`…:<type>:<id>`). */
function kindOf(device) {
  for (const type of [STOP_TYPE, BIKE_TYPE, LINES_TYPE]) {
    if (device.external_id.includes(`${type}:`)) return type;
  }
  return null;
}

/** "3 arrêts, 1 station Mobi et les lignes" — or its English twin. */
export function inventory({ stops, stations, lines }) {
  const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`;
  const join = (parts, and) =>
    parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} ${and} ${parts.at(-1)}`;
  const en = [];
  const fr = [];
  if (stops > 0) {
    en.push(plural(stops, 'stop'));
    fr.push(plural(stops, 'arrêt'));
  }
  if (stations > 0) {
    en.push(plural(stations, `${BIKE_SHARE} station`));
    fr.push(stations > 1 ? `${stations} stations ${BIKE_SHARE}` : `1 station ${BIKE_SHARE}`);
  }
  if (lines) {
    en.push('the lines');
    fr.push('les lignes');
  }
  return { en: join(en, 'and'), fr: join(fr, 'et') };
}

const NOTHING_YET = {
  no_location: {
    en: 'To find the stops near you, set the address of your house in Gladys (Settings → Houses), then save this configuration again. Or type a stop code below.',
    fr: 'Pour trouver les arrêts près de chez vous, indiquez l’adresse de votre maison dans Gladys (Paramètres → Maisons), puis enregistrez à nouveau cette configuration. Ou tapez un code d’arrêt ci-dessous.',
  },
  no_house: {
    en: 'Gladys did not share the location of your house: type a stop code below, or reinstall the integration and accept the location access.',
    fr: 'Gladys n’a pas partagé la position de votre maison : tapez un code d’arrêt ci-dessous, ou réinstallez l’intégration en acceptant l’accès à la position.',
  },
  failed: {
    en: 'The stops near your house could not be looked up right now: save the configuration again in a few minutes, or type a stop code below.',
    fr: 'Les arrêts près de chez vous n’ont pas pu être cherchés : enregistrez à nouveau la configuration dans quelques minutes, ou tapez un code d’arrêt ci-dessous.',
  },
  disabled: {
    en: 'Nothing to watch yet: type a stop code below, or turn the suggestions near your house back on.',
    fr: 'Rien à surveiller : tapez un code d’arrêt ci-dessous, ou réactivez les suggestions près de chez vous.',
  },
};

// The lookups that failed for a reason the user can fix.
const LOOKUP_PROBLEMS = new Set(['no_location', 'no_house', 'failed']);

/**
 * What the status line says, and whether the integration counts as connected.
 *
 * @param {object} gladys
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @returns {{ connected: boolean, message: { en: string, fr: string } }}
 */
export function describeStatus(gladys, config) {
  const discovered = buildDiscoveredDevices(gladys, config);
  if (discovered.length === 0) {
    const reason = NOTHING_YET[getSuggestions().status] ?? NOTHING_YET.disabled;
    return { connected: false, message: reason };
  }

  const count = (devices, type) => devices.filter((device) => kindOf(device) === type).length;
  const stops = count(discovered, STOP_TYPE);

  if (stops > 0 && departuresSource(config) === 'none') {
    return {
      connected: false,
      message: {
        en: `Stops need a ${KEY?.en ?? 'key'}, or the departures without a key turned on: see the documentation of the integration.`,
        fr: `Les arrêts demandent une ${KEY?.fr ?? 'clé'}, ou les passages sans clé activés : voir la documentation de l’intégration.`,
      },
    };
  }

  // The line device needs no house: when it is all there is, the reason no
  // stop was found still has to reach the user.
  const lookup = getSuggestions().status;
  const houseHint =
    stops === 0 && count(discovered, BIKE_TYPE) === 0 && LOOKUP_PROBLEMS.has(lookup)
      ? { en: ` ${NOTHING_YET[lookup].en}`, fr: ` ${NOTHING_YET[lookup].fr}` }
      : { en: '', fr: '' };

  const created = new Set((gladys.devices ?? []).map((device) => device.external_id));
  const waiting = discovered.filter((device) => !created.has(device.external_id));
  const keyHint =
    !NETWORK.realtime || hasRealtime(config) || stops === 0
      ? { en: '', fr: '' }
      : config.watched.lines && NETWORK.lines.length > 0
        ? {
            en: ` Without a key: a free ${NETWORK.operator} key adds the official real time and the line status.`,
            fr: ` Sans clé : une clé ${NETWORK.operator} gratuite ajoute le temps réel officiel et l’état des lignes.`,
          }
        : {
            en: ` Without a key: a free ${NETWORK.operator} key adds the official real time.`,
            fr: ` Sans clé : une clé ${NETWORK.operator} gratuite ajoute le temps réel officiel.`,
          };

  if (waiting.length > 0) {
    const what = inventory({
      stops: count(waiting, STOP_TYPE),
      stations: count(waiting, BIKE_TYPE),
      lines: count(waiting, LINES_TYPE) > 0,
    });
    return {
      connected: true,
      message: {
        en: `Ready: ${what.en} to add. Open the “Discover” tab of this integration and press “Add”.${keyHint.en}${houseHint.en}`,
        fr: `Prêt : ${what.fr} à ajouter. Ouvrez l’onglet « Découverte » de cette intégration et cliquez sur « Ajouter ».${keyHint.fr}${houseHint.fr}`,
      },
    };
  }

  const what = inventory({
    stops,
    stations: count(discovered, BIKE_TYPE),
    lines: count(discovered, LINES_TYPE) > 0,
  });
  const requests = estimatedDailyRequests(config, { stops });
  const quota = hasApiKey(config)
    ? {
        en: ` (about ${requests} ${NETWORK.operator} requests a day).`,
        fr: ` (environ ${requests} requêtes ${NETWORK.operator} par jour).`,
      }
    : { en: '.', fr: '.' };
  return {
    connected: true,
    message: {
      en: `Connected. Watching ${what.en}${quota.en}${keyHint.en}${houseHint.en}`,
      fr: `Connecté. Surveille ${what.fr}${quota.fr}${keyHint.fr}${houseHint.fr}`,
    },
  };
}
