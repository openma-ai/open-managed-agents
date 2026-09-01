import { describe, expect, it } from "vitest";
import { iterateJsonSseStream } from "./sse";

function chunkedBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("Managed Agents SSE decoder", () => {
  it("handles fragmented CRLF frames, multiline JSON, and ping heartbeats", async () => {
    const body = chunkedBody([
      "event: pi",
      "ng\r\ndata: {}\r\n\r\nevent: agent.message\r\n",
      'data: {"type":\r\n',
      'data: "agent.message","message":"hi"}\r\n\r\n',
    ]);

    const events: unknown[] = [];
    for await (const event of iterateJsonSseStream(body)) events.push(event);

    expect(events).toEqual([{ type: "agent.message", message: "hi" }]);
  });

  it("turns an SSE error envelope into a failed async iteration", async () => {
    const body = chunkedBody([
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"stream broke"}}\n\n',
    ]);

    const consume = async () => {
      for await (const _event of iterateJsonSseStream(body)) {
        // The error frame must never be yielded as a session event.
      }
    };

    await expect(consume()).rejects.toThrow("stream broke");
  });
});
