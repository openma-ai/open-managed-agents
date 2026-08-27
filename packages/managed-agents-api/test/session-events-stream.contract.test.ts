import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionEventsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/events/stream", () => {
  it("maps delta subscriptions and emits official event_start/event_delta SSE data", async () => {
    const streamCalls: unknown[] = [];
    const port = makeSessionEventsPort({
      streamSessionEvents: async (query) => {
        streamCalls.push(query);
        return {
          type: "stream",
          events: (async function* () {
            yield {
              type: "event_start" as const,
              event: { id: "event_agent_message_01", type: "agent.message" as const },
            };
            yield {
              type: "event_delta" as const,
              eventId: "event_agent_message_01",
              delta: {
                type: "content_delta" as const,
                content: { type: "text" as const, text: "Hello" },
                index: 0,
              },
            };
          })(),
        };
      },
    });
    const api = buildSessionEventsTestApi(port);
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

    const stream = await client.beta.sessions.events.stream(sessionWire.id, {
      event_deltas: ["agent.message", "agent.thinking"],
    });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(streamCalls).toEqual([
      {
        sessionId: sessionWire.id,
        deltaEventTypes: ["agent.message", "agent.thinking"],
      },
    ]);
    expect(events).toEqual([
      {
        type: "event_start",
        event: { id: "event_agent_message_01", type: "agent.message" },
      },
      {
        type: "event_delta",
        event_id: "event_agent_message_01",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "Hello" },
          index: 0,
        },
      },
    ]);
  });
});
