import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  makeSessionThreadEventsPort,
  makeSessionThreadsPort,
} from "./session-thread-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionThreadsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/threads/:thread_id/events", () => {
  it("maps thread event pagination through its dedicated port", async () => {
    const listCalls: unknown[] = [];
    const eventPort = makeSessionThreadEventsPort({
      listSessionThreadEvents: async (query) => {
        listCalls.push(query);
        return {
          type: "page",
          page: {
            events: [
              {
                id: "event_thread_system_01",
                type: "system.message",
                content: [{ type: "text", text: "Thread policy" }],
                processedAt: "2026-08-26T06:30:00.000Z",
              },
            ],
            nextCursor: "thread_event_page_02",
          },
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

    const page = await client.beta.sessions.threads.events.list("sthr_child_04", {
      session_id: sessionWire.id,
      limit: 25,
      page: "thread_event_page_01",
    });

    expect(listCalls).toEqual([
      {
        sessionId: sessionWire.id,
        threadId: "sthr_child_04",
        pageSize: 25,
        cursor: "thread_event_page_01",
      },
    ]);
    expect(page.data).toEqual([
      {
        id: "event_thread_system_01",
        type: "system.message",
        content: [{ type: "text", text: "Thread policy" }],
        processed_at: "2026-08-26T06:30:00.000Z",
      },
    ]);
    expect(page.next_page).toBe("thread_event_page_02");
  });
});
