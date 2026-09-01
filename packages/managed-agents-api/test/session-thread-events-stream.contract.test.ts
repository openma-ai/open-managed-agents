import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  makeSessionThreadEventsPort,
  makeSessionThreadsPort,
} from "./session-thread-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionThreadsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/threads/:thread_id/stream", () => {
  it("keeps thread stream transport outside the dedicated application port", async () => {
    const streamCalls: unknown[] = [];
    const eventPort = makeSessionThreadEventsPort({
      streamSessionThreadEvents: async (query) => {
        streamCalls.push(query);
        return {
          type: "stream",
          events: (async function* () {
            yield {
              type: "event_start" as const,
              event: { id: "event_thread_message_01", type: "agent.message" as const },
            };
            yield {
              type: "event_delta" as const,
              eventId: "event_thread_message_01",
              delta: {
                type: "content_delta" as const,
                content: { type: "text" as const, text: "Child result" },
              },
            };
          })(),
        };
      },
    });
    const api = buildSessionThreadsTestApi(makeSessionThreadsPort({}), eventPort);
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    const stream = await client.beta.sessions.threads.events.stream(
      "sthr_child_05",
      {
        session_id: sessionWire.id,
        event_deltas: ["agent.message"],
      },
    );
    const events = [];
    for await (const event of stream) events.push(event);

    expect(streamCalls).toEqual([
      {
        sessionId: sessionWire.id,
        threadId: "sthr_child_05",
        deltaEventTypes: ["agent.message"],
      },
    ]);
    expect(events).toEqual([
      {
        type: "event_start",
        event: { id: "event_thread_message_01", type: "agent.message" },
      },
      {
        type: "event_delta",
        event_id: "event_thread_message_01",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "Child result" },
        },
      },
    ]);
  });
});
