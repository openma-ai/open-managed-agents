import { proxy } from "hono/proxy";

/**
 * The single HTTP hop used by every OpenMA proxy route (MCP, inference,
 * Matter) on both hosts. Callers decide *what* to send — target URL, the
 * credential headers to inject, the caller headers to withhold, the body —
 * and this sends it.
 *
 * Header hygiene is Hono's `proxy()`: it drops hop-by-hop headers (and any
 * listed in `Connection`) on the request and the response, drops
 * `accept-encoding`, and drops `content-encoding`/`content-length` from a
 * response whose body fetch has already decoded. `proxy()` only cleans the
 * headers of its `raw` request, so the outgoing request is assembled first
 * and handed over as `raw`.
 */
export interface ProxyUpstreamInput {
  readonly url: string;
  readonly method: string;
  /** The caller's request headers, forwarded end to end. */
  readonly headers: Headers;
  /** Already buffered so a caller can replay it (e.g. after a token refresh). */
  readonly body?: BodyInit | null;
  /** Headers to set on the upstream request, replacing caller values. */
  readonly set?: Readonly<Record<string, string>>;
  /** Caller headers to withhold from the upstream (case-insensitive). */
  readonly drop?: Iterable<string>;
  /** Withhold every caller header with one of these prefixes. */
  readonly dropPrefixes?: Iterable<string>;
  readonly fetcher?: typeof fetch;
}

/** Not hop-by-hop, but describe the inbound hop: fetch derives `host` and
 * `content-length` from the target and body, and Node's fetch rejects
 * `expect` (UND_ERR_NOT_SUPPORTED). */
const PER_HOP = ["host", "content-length", "expect"];

export async function proxyUpstream(input: ProxyUpstreamInput): Promise<Response> {
  const headers = new Headers(input.headers);
  for (const name of [...PER_HOP, ...(input.drop ?? [])]) headers.delete(name);
  const prefixes = [...(input.dropPrefixes ?? [])].map((prefix) => prefix.toLowerCase());
  if (prefixes.length > 0) {
    for (const name of [...headers.keys()]) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) headers.delete(name);
    }
  }
  for (const [name, value] of Object.entries(input.set ?? {})) headers.set(name, value);

  const method = input.method.toUpperCase();
  const raw = new Request(input.url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? null : input.body ?? null,
  });
  return proxy(input.url, {
    raw,
    // Never replay injected credentials to a redirect target; the caller
    // decides whether a redirect is part of its protocol.
    redirect: "manual",
    strictConnectionProcessing: true,
    ...(input.fetcher ? { customFetch: input.fetcher } : {}),
  });
}
