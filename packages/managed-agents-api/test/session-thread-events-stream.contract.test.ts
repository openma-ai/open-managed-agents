import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
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

  it("releases the application stream and stops reading once the client disconnects", async () => {
    let nextCalls = 0;
    let returnCalls = 0;
    let wake: ((result: IteratorResult<never>) => void) | null = null;
    const queued: unknown[] = [];
    const push = (event: unknown) => {
      if (wake === null) {
        queued.push(event);
        return;
      }
      const resolve = wake;
      wake = null;
      resolve({ value: event as never, done: false });
    };
    const iterator: AsyncIterator<never> = {
      next() {
        nextCalls += 1;
        if (queued.length > 0) {
          return Promise.resolve({ value: queued.shift() as never, done: false });
        }
        return new Promise((resolve) => {
          wake = resolve;
        });
      },
      return() {
        returnCalls += 1;
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
    const message = (id: string) => ({
      type: "event_start" as const,
      event: { id, type: "agent.message" as const },
    });
    const eventPort = makeSessionThreadEventsPort({
      streamSessionThreadEvents: async () => ({
        type: "stream",
        events: { [Symbol.asyncIterator]: () => iterator },
      }),
    });
    const api = buildSessionThreadsTestApi(makeSessionThreadsPort({}), eventPort);
    const response = await api.request(
      `/v1/sessions/${sessionWire.id}/threads/sthr_child_05/stream`,
      {
        headers: {
          "anthropic-beta": "managed-agents-2026-04-01",
          "x-api-key": "test-key",
        },
      },
    );
    const reader = response.body!.getReader();
    push(message("event_thread_message_01"));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event_thread_message_01");

    await reader.cancel();
    await vi.waitFor(() => expect(returnCalls).toBe(1));
    const nextCallsAtDisconnect = nextCalls;
    push(message("event_thread_message_02"));
    push(message("event_thread_message_03"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(nextCalls).toBe(nextCallsAtDisconnect);
    expect(returnCalls).toBe(1);
  });
});
