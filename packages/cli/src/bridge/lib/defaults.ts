/**
 * Hosted Console + API origin used by CLI login/API defaults and by
 * `oma bridge setup` / the runtime daemon.
 *
 * Live hosts (verified 2026-11-02):
 *   - Marketing apex: https://openma.ai (openma.dev → 301 here)
 *   - Console + API:  https://app.openma.ai (app.openma.dev → 301 here)
 *   - Docs:           https://docs.openma.ai
 *   - api.openma.ai / api.openma.dev: do not resolve
 *
 * Do not point bridge/API traffic at the apex marketing site: it does not
 * serve `/v1/*`, and redirects on some paths can change POST to GET.
 */
export const DEFAULT_API_BASE_URL = "https://app.openma.ai";

/** @see DEFAULT_API_BASE_URL */
export const DEFAULT_BRIDGE_SERVER_URL = DEFAULT_API_BASE_URL;
