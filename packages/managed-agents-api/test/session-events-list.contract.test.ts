import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionEventsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/events", () => {
  it("returns an explicit null next_page on the final page", async () => {
    const api = buildSessionEventsTestApi(makeSessionEventsPort({
      listSessionEvents: async () => ({
        type: "page",
        page: { events: [], nextCursor: undefined },
      }),
    }));
    const response = await api.request(
      `/v1/sessions/${sessionWire.id}/events`,
      { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], next_page: null });
  });

  it("maps official filters and the session.usage event into a cursor page", async () => {
    const listCalls: unknown[] = [];
    const port = makeSessionEventsPort({
      listSessionEvents: async (query) => {
        listCalls.push(query);
        return {
          type: "page",
          page: {
            events: [
              {
                id: "event_system_01",
                type: "system.message",
                content: [{ type: "text", text: "Policy updated" }],
                processedAt: "2026-08-26T04:00:00.000Z",
              },
              {
                id: "event_usage_01",
                type: "session.usage",
                processedAt: "2026-08-26T04:00:01.000Z",
                usage: {
                  activeSeconds: 12.5,
                  cacheCreation: {
                    ephemeralOneHourInputTokens: 100,
                    ephemeralFiveMinuteInputTokens: 25,
                  },
                  cacheReadInputTokens: 50,
                  inputTokens: 500,
                  listCost: { amountMinor: "75", currency: "USD" },
                  outputTokens: 125,
                  serverToolUse: {
                    webFetchRequests: 2,
                    webSearchRequests: 1,
                  },
                },
                budget: { amountMinor: "2500", currency: "USD" },
              },
            ],
            nextCursor: "event_page_02",
          },
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

    const page = await client.beta.sessions.events.list(sessionWire.id, {
      limit: 20,
      page: "event_page_01",
      "created_at[gt]": "2026-08-01T00:00:00.000Z",
      "created_at[gte]": "2026-08-02T00:00:00.000Z",
      "created_at[lt]": "2026-09-01T00:00:00.000Z",
      "created_at[lte]": "2026-08-31T23:59:59.999Z",
      order: "desc",
      types: ["system.message", "session.usage"],
    });

    expect(listCalls).toEqual([
      {
        sessionId: sessionWire.id,
        pageSize: 20,
        cursor: "event_page_01",
        createdAfter: "2026-08-01T00:00:00.000Z",
        createdAtOrAfter: "2026-08-02T00:00:00.000Z",
        createdBefore: "2026-09-01T00:00:00.000Z",
        createdAtOrBefore: "2026-08-31T23:59:59.999Z",
        order: "desc",
        types: ["system.message", "session.usage"],
      },
    ]);
    expect(page.data).toEqual([
      {
        id: "event_system_01",
        type: "system.message",
        content: [{ type: "text", text: "Policy updated" }],
        processed_at: "2026-08-26T04:00:00.000Z",
      },
      {
        id: "event_usage_01",
        type: "session.usage",
        processed_at: "2026-08-26T04:00:01.000Z",
        usage: {
          active_seconds: 12.5,
          cache_creation: {
            ephemeral_1h_input_tokens: 100,
            ephemeral_5m_input_tokens: 25,
          },
          cache_read_input_tokens: 50,
          input_tokens: 500,
          list_cost: { amount: "75", currency: "USD" },
          output_tokens: 125,
          server_tool_use: {
            web_fetch_requests: 2,
            web_search_requests: 1,
          },
        },
        budget: {
          type: "limit",
          max_list_cost: { amount: "2500", currency: "USD" },
        },
      },
    ]);
    expect(page.next_page).toBe("event_page_02");
  });
});
