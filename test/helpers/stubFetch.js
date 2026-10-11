// -----------------------------------------------------------------------------
// `fetch` stand-in shared by the suites that exercise the real HTTP clients.
//
// Every outgoing request is routed to an in-memory response, keyed by a
// substring of the URL, so the tests cover the real code path without
// touching the network. Requests to an unmapped URL fail the test loudly.
//
// A route is either:
//   - a plain object / array: a 200 JSON body;
//   - a Uint8Array: a 200 binary body (a GTFS-Realtime feed);
//   - { status, body }: any status, with a text body (an operator refusal).
// -----------------------------------------------------------------------------

const realFetch = globalThis.fetch;

/**
 * Replace `fetch` with the routes given, and return the list of the requests
 * it received (`{ url, headers }`). A route is a body, `{ status, body }`, or a
 * function of the URL returning one of those.
 * @param {Record<string, unknown>} routes
 */
export function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, headers: options.headers ?? {} });
    const match = Object.keys(routes).find((fragment) => href.includes(fragment));
    if (!match) {
      throw new Error(`Unexpected request: ${href}`);
    }
    // A function answers from the request (NextBus: one answer per stopId).
    const route = typeof routes[match] === 'function' ? routes[match](href) : routes[match];
    const explicit =
      route && typeof route === 'object' && 'status' in route && !(route instanceof Uint8Array);
    const status = explicit ? route.status : 200;
    const body = explicit ? route.body : route;
    return {
      ok: status < 400,
      status,
      headers: new Headers(),
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      arrayBuffer: async () => {
        const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
  return calls;
}

/** Put the real `fetch` back (afterEach). */
export function restoreFetch() {
  globalThis.fetch = realFetch;
}
