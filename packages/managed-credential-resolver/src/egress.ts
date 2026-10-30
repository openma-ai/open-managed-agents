/**
 * Header rewrite for a sandbox request leaving through a Vault egress proxy.
 */

/**
 * Headers a forwarding hop must not replay: intermediary artifacts (CF edge,
 * forwarding proxies) and `host`, which the runtime derives from the URL.
 * Some appear in upstream SigV4 signed-header lists, so replaying them
 * breaks signatures.
 */
export const EGRESS_HOP_HEADERS: readonly string[] = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cf-ew-via",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "x-amzn-trace-id",
  "host",
];

/** Sandbox-supplied control and ambient credentials that never go upstream. */
export const EGRESS_SANDBOX_CONTROL_HEADERS: readonly string[] = [
  "x-api-key",
  "proxy-authorization",
  "cookie",
  "x-active-tenant",
];

/**
 * Outgoing headers for a sandbox egress request. `stripAuthorization` drops
 * the sandbox's own `Authorization` (enforced egress); a selected Vault
 * token always replaces it.
 */
export function egressRequestHeaders(
  inbound: Headers,
  input: { token: string | null; stripAuthorization: boolean; header?: import("@open-managed-agents/cap").HeaderInjectSpec },
): Headers {
  const headers = new Headers(inbound);
  for (const name of EGRESS_HOP_HEADERS) headers.delete(name);
  for (const name of EGRESS_SANDBOX_CONTROL_HEADERS) headers.delete(name);
  if (input.stripAuthorization) headers.delete("authorization");
  for (const name of input.header?.strip ?? []) headers.delete(name);
  if (input.token !== null) {
    if (input.header) headers.set(input.header.set.name, input.header.set.value.replaceAll("${token}", input.token));
    else headers.set("authorization", `Bearer ${input.token}`);
  }
  return headers;
}
