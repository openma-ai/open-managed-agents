/** Minimal SSE framing for the official Managed Agents async-iterable stream.
 * Fetch/auth/error negotiation lives in `useApi().apiStream`; this module only
 * consumes one successful response body. */

interface SseFrame {
  data: string;
  event: string | null;
}

/** Parse a single authenticated Managed Agents SSE response into the same
 * JSON values exposed by the official SDK's async-iterable Stream. Ping frames
 * are transport heartbeats and are deliberately not yielded. */
export async function* iterateJsonSseStream<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  for await (const frame of iterateSseFrames(body)) {
    if (frame.event === "ping") continue;
    const value = JSON.parse(frame.data) as T | {
      error?: { message?: unknown };
    };
    if (frame.event === "error") {
      const message =
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error?.message === "string"
          ? value.error.message
          : "Managed Agents event stream failed";
      throw new Error(message);
    }
    yield value as T;
  }
}

async function* iterateSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
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
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
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
 * Pull `event:` and `data:` content out of one SSE frame. Comments and
 * unrecognized fields (`id:`, `retry:`) are ignored. Multi-line data is
 * joined with `\n` per the spec.
 */
function parseSseFrame(frame: string): SseFrame | null {
  const dataLines: string[] = [];
  let event: string | null = null;
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      // Spec: optional single space after the colon is stripped.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("event:")) {
      event = line.slice(6).replace(/^ /, "");
    }
  }
  if (dataLines.length === 0) return null;
  return { data: dataLines.join("\n"), event };
}
