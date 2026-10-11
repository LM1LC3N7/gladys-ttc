// -----------------------------------------------------------------------------
// The one place this integration talks HTTP.
//
// Node 22+ ships `fetch`: no dependency. Every request carries a timeout (a
// stalled socket must not hold a poll forever) and a User-Agent naming the
// integration, which is what an open-data operator looks for in its logs
// before blocking an anonymous client.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

// The package name is the repository name: one source for the sister
// integrations.
const { name, version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

export const USER_AGENT = `${name}/${version} (+https://github.com/LM1LC3N7/${name})`;

// One request to the operator or to the bike share answers in well under a
// second; ten seconds is a stalled connection, not a slow server.
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * `fetch` with the integration's timeout and User-Agent.
 *
 * @param {string} url
 * @param {{ headers?: Record<string, string> }} [options]
 * @returns {Promise<Response>}
 */
export function request(url, { headers = {} } = {}) {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}
