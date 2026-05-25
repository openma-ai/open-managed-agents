/**
 * Native SSE client. Replaces `@microsoft/fetch-event-source`, which
 * stopped getting releases in 2020 and required a transitive copy of
 * `event-source-polyfill`-era utilities. The browser fetch + ReadableStream
 * pair has been baseline for years; the only thing the old lib was buying
 * us was the `text/event-stream` framing parser, which is ~40 lines.
 *
 * Features kept from the old call site (lib/api.ts streamEvents):
 *   - `credentials: 'include'` for cookie auth.
 *   - Custom headers (e.g. `x-active-tenant`).
 *   - `signal` for caller-initiated abort.
 *   - `openWhenHidden`-equivalent: we don't tear down on visibilitychange;
 *     the connection only ends when caller aborts or `onError` returns null.
 *   - `onOpen(response)` hook to inspect the handshake — handlers can
 *     throw `FatalError` (no retry) or `RetriableError` (loop with the
 *     backoff returned from `onError`).
 *   - Per-frame `onMessage(data)`. Empty data (keepalive `:` comments,
 *     blank `data:`) is filtered before reaching the caller.
 *   - Auto-reconnect: when the stream ends or errors, `onError` is asked
 *     for the delay before the next attempt; return `null` to give up.
 */

export class FatalSseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalSseError";
  }
}

export interface StreamSseOpts {
  /** Request headers to merge into the GET. */
  headers?: Record<string, string>;
  /** Caller's abort signal. Aborts terminate the loop without onError. */
  signal?: AbortSignal;
  /** Inspect the open response (status, headers). Throw FatalSseError to
   *  abort permanently; throw any other error to trigger a retry via
   *  onError. Default: accept 2xx, throw FatalSseError on 4xx, throw a
   *  retriable error on other non-2xx. */
  onOpen?: (response: Response) => void | Promise<void>;
  /** Called for each non-empty `data:` payload. */
  onMessage: (data: string) => void;
  /** Stream-ended hook. Return milliseconds-until-reconnect, or `null`
   *  to stop. The default never reconnects (returns null). Callers that
   *  want auto-reconnect implement their own backoff. */
  onError?: (err: unknown) => number | null;
}

export async function streamSse(url: string, opts: StreamSseOpts): Promise<void> {
  const { headers, signal, onOpen, onMessage, onError } = opts;

  while (true) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: "text/event-stream",
          ...(headers ?? {}),
        },
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      const delay = onError?.(err) ?? null;
      if (delay == null) throw err;
      await sleep(delay, signal);
      continue;
    }

    try {
      if (onOpen) {
        await onOpen(response);
      } else if (!response.ok) {
        throw response.status >= 400 && response.status < 500
          ? new FatalSseError(`SSE ${response.status}`)
          : new Error(`SSE ${response.status}`);
      }
    } catch (err) {
      if (err instanceof FatalSseError) throw err;
      if (signal?.aborted) return;
      const delay = onError?.(err) ?? null;
      if (delay == null) throw err;
      await sleep(delay, signal);
      continue;
    }

    if (!response.body) {
      // No body to stream — treat as terminal error like the old lib did.
      const delay = onError?.(new Error("SSE response has no body")) ?? null;
      if (delay == null) return;
      await sleep(delay, signal);
      continue;
    }

    try {
      await readSseStream(response.body, onMessage);
      // Reached end of stream cleanly — server closed the connection.
      // Fall through to onError for the reconnect decision (matches the
      // old lib's onclose-throw-RetriableError pattern).
      const delay = onError?.(new Error("SSE stream closed")) ?? null;
      if (delay == null) return;
      await sleep(delay, signal);
    } catch (err) {
      if (signal?.aborted) return;
      const delay = onError?.(err) ?? null;
      if (delay == null) throw err;
      await sleep(delay, signal);
    }
  }
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE spec: events are separated by an empty line (`\n\n`). A
      // single CRLF or LF works too; normalize before splitting.
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      let sepIdx = buffer.indexOf("\n\n");
      while (sepIdx !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const data = parseSseFrame(frame);
        if (data) onMessage(data);
        sepIdx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Cancel rather than release so the connection actually closes —
    // releaseLock alone leaves the underlying socket open until GC.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Pull `data:` content out of one SSE frame. Comments (lines starting
 * with `:`) and unrecognized fields (`event:`, `id:`, `retry:`) are
 * ignored — OMA's stream only uses `data:`. Multi-line data is joined
 * with `\n` per the spec.
 */
function parseSseFrame(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      // Spec: optional single space after the colon is stripped.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

/** Promise sleep that resolves immediately when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
