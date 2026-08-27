import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionThreadsPort } from "./session-thread-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionThreadsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions/:session_id/threads", () => {
  it("maps pagination and both official thread agent variants", async () => {
    const listCalls: unknown[] = [];
    const port = makeSessionThreadsPort({
      listSessionThreads: async (query) => {
        listCalls.push(query);
        return {
          type: "page",
          page: {
            threads: [
              {
                id: "sthr_primary_01",
                agent: {
                  type: "agent",
                  id: sessionWire.agent.id,
                  description: null,
                  mcpServers: [],
                  model: { id: "claude-opus-5", effort: "high" },
                  name: "Coding Assistant",
                  skills: [],
                  system: null,
                  tools: [],
                  version: 3,
                },
                archivedAt: null,
                createdAt: "2026-08-26T06:00:00.000Z",
                parentThreadId: null,
                sessionId: sessionWire.id,
                stats: {
                  activeSeconds: 8,
                  durationSeconds: 20,
                  startupSeconds: 1,
                },
                status: "running",
                updatedAt: "2026-08-26T06:00:20.000Z",
                usage: {
                  inputTokens: 100,
                  outputTokens: 25,
                  listCost: { amountMinor: "15", currency: "USD" },
                },
              },
              {
                id: "sthr_advisor_01",
                agent: { type: "advisor", model: "claude-sonnet-5" },
                archivedAt: null,
                createdAt: "2026-08-26T06:00:05.000Z",
                parentThreadId: "sthr_primary_01",
                sessionId: sessionWire.id,
                stats: null,
                status: "idle",
                updatedAt: "2026-08-26T06:00:10.000Z",
                usage: null,
              },
            ],
            nextCursor: "thread_page_02",
          },
        };
      },
    });
    const api = buildSessionThreadsTestApi(port);
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

    const page = await client.beta.sessions.threads.list(sessionWire.id, {
      limit: 10,
      page: "thread_page_01",
    });

    expect(listCalls).toEqual([
      { sessionId: sessionWire.id, pageSize: 10, cursor: "thread_page_01" },
    ]);
    expect(page.data).toEqual([
      {
        id: "sthr_primary_01",
        agent: {
          type: "agent",
          id: sessionWire.agent.id,
          description: null,
          mcp_servers: [],
          model: { id: "claude-opus-5", effort: { type: "high" } },
          name: "Coding Assistant",
          skills: [],
          system: null,
          tools: [],
          version: 3,
        },
        archived_at: null,
        created_at: "2026-08-26T06:00:00.000Z",
        parent_thread_id: null,
        session_id: sessionWire.id,
        stats: {
          active_seconds: 8,
          duration_seconds: 20,
          startup_seconds: 1,
        },
        status: "running",
        type: "session_thread",
        updated_at: "2026-08-26T06:00:20.000Z",
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          list_cost: { amount: "15", currency: "USD" },
        },
      },
      {
        id: "sthr_advisor_01",
        agent: { type: "advisor", model: "claude-sonnet-5" },
        archived_at: null,
        created_at: "2026-08-26T06:00:05.000Z",
        parent_thread_id: "sthr_primary_01",
        session_id: sessionWire.id,
        stats: null,
        status: "idle",
        type: "session_thread",
        updated_at: "2026-08-26T06:00:10.000Z",
        usage: null,
      },
    ]);
    expect(page.next_page).toBe("thread_page_02");
  });
});
