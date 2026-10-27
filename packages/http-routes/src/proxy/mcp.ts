import { proxyUpstream } from "./forward";

/**
 * Caller headers an MCP proxy never forwards upstream: credentials that
 * authenticate the caller to OpenMA (the upstream gets the Vault bearer
 * instead), edge metadata about the caller, and OpenMA routing headers.
 */
export const MCP_PROXY_WITHHELD_HEADERS: readonly string[] = [
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "cookie",
  "x-active-tenant",
  "cf-connecting-ip",
  "cf-ray",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
];

const MCP_PROXY_WITHHELD_PREFIXES: readonly string[] = ["x-oma-"];

export interface SendMcpUpstreamInput {
  readonly upstreamUrl: string;
  readonly method: string;
  readonly headers: Headers;
  /** Buffered, so a token refresh can replay it. */
  readonly body: BodyInit | null;
  /** Vault bearer injected as `Authorization: Bearer …`. */
  readonly accessToken: string;
  readonly fetcher?: typeof fetch;
}

/** One MCP upstream attempt with the Vault bearer injected. */
export function sendMcpUpstream(input: SendMcpUpstreamInput): Promise<Response> {
  return proxyUpstream({
    url: input.upstreamUrl,
    method: input.method,
    headers: input.headers,
    body: input.body,
    set: { authorization: `Bearer ${input.accessToken}` },
    drop: MCP_PROXY_WITHHELD_HEADERS,
    dropPrefixes: MCP_PROXY_WITHHELD_PREFIXES,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}
