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
  /** Lifetime of the inbound exchange, including the response body. */
  readonly signal?: AbortSignal | null;
  readonly fetcher?: typeof fetch;
}

/** Not hop-by-hop, but describe the inbound hop: fetch derives `host` and
 * `content-length` from the target and body, and Node's fetch rejects
 * `expect` (UND_ERR_NOT_SUPPORTED). */
const PER_HOP = ["host", "content-length", "expect"];

export async function proxyUpstream(input: ProxyUpstreamInput): Promise<Response> {
  input.signal?.throwIfAborted();
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
    signal: input.signal ?? undefined,
  });
  const response = await proxy(input.url, {
    raw,
    // Never replay injected credentials to a redirect target; the caller
    // decides whether a redirect is part of its protocol.
    redirect: "manual",
    strictConnectionProcessing: true,
    ...(input.fetcher ? { customFetch: input.fetcher } : {}),
  });
  return observeProxyBody(response, input.signal);
}

/** A resolved fetch only owns the headers. Keep body errors observed even
 * before the caller starts reading; preserve them for that caller rather
 * than replacing an interrupted response with a successful truncated body.
 * Reading starts only when the caller asks for a chunk. In particular a 401
 * discarded for OAuth refresh must not create a speculative pending read. */
export function observeProxyBody(response: Response, signal?: AbortSignal | null): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const detach = () => signal?.removeEventListener("abort", aborted);
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true; detach(); controller.error(error);
  };
  const cancelReader = async (reason: unknown) => {
    try { await reader.cancel(reason); } finally { reader.releaseLock(); }
  };
  const aborted = () => {
    fail(signal!.reason);
    // The response is already errored with the cancellation reason. Observe
    // remote cleanup failure too, without inventing an unhandled promise.
    void cancelReader(signal!.reason).catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      void reader.closed.catch(fail);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    },
    async pull(value) {
      if (stopped) return;
      try {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) { stopped = true; detach(); value.close(); reader.releaseLock(); }
        else value.enqueue(next.value);
      } catch (error) { fail(error); }
    },
    async cancel(reason) {
      if (stopped) return;
      stopped = true; detach(); await cancelReader(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
