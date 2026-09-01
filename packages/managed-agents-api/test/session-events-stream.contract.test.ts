import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildSessionEventRoutes } from "../src";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionEventsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/events/stream", () => {
  it("surfaces application stream failures as an Anthropic SSE error", async () => {
    const port = makeSessionEventsPort({
      streamSessionEvents: async () => ({
        type: "stream",
        events: (async function* () {
          throw new Error("runtime socket failed");
        })(),
      }),
    });
    const api = new Hono().route(
      "/v1/sessions",
      buildSessionEventRoutes(port),
    );
    const response = await api.request(
      `/v1/sessions/${sessionWire.id}/events/stream`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    await expect(response.text()).resolves.toContain("runtime socket failed");
  });

  it("surfaces invalid application events as an Anthropic SSE error instead of a silent close", async () => {
    const port = makeSessionEventsPort({
      streamSessionEvents: async () => ({
        type: "stream",
        events: (async function* () {
          yield { type: "session.status_running" } as never;
        })(),
      }),
    });
    const api = new Hono().route(
      "/v1/sessions",
      buildSessionEventRoutes(port),
    );
    const response = await api.request(
      `/v1/sessions/${sessionWire.id}/events/stream`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    await expect(response.text()).resolves.toContain("event: error");
  });

  it("emits SDK-compatible ping heartbeats while the application stream is idle", async () => {
    vi.useFakeTimers();
    try {
      const port = makeSessionEventsPort({
        streamSessionEvents: async () => ({
          type: "stream",
          events: (async function* () {
            await new Promise(() => undefined);
          })(),
        }),
      });
      const api = new Hono().route(
        "/v1/sessions",
        buildSessionEventRoutes(port),
      );
      const response = await api.request(
        `/v1/sessions/${sessionWire.id}/events/stream`,
        { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
      );
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = reader!.read();

      await vi.advanceTimersByTimeAsync(10_001);
      const result = await Promise.race([
        firstChunk,
        Promise.resolve({ done: false, value: new TextEncoder().encode("<missing>") }),
      ]);

      expect(new TextDecoder().decode(result.value)).toContain("event: ping");
      await reader!.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps delta subscriptions and emits official event_start/event_delta SSE data", async () => {
    const streamCalls: unknown[] = [];
    const port = makeSessionEventsPort({
      streamSessionEvents: async (query) => {
        streamCalls.push(query);
        return {
          type: "stream",
          events: (async function* () {
            yield {
              id: "event_status_01",
              type: "session.status_running" as const,
              processedAt: "2026-08-26T02:00:00.000Z",
            };
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
        id: "event_status_01",
        type: "session.status_running",
        processed_at: "2026-08-26T02:00:00.000Z",
      },
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
