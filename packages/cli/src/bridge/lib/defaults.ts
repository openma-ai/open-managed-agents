/**
 * API origin used by `oma bridge setup` and the runtime daemon.
 *
 * Do not point this at the apex marketing site: it redirects `/agents/*`
 * requests, and a 301 changes the exchange request from POST to GET.
 */
export const DEFAULT_BRIDGE_SERVER_URL = "https://app.openma.dev";
