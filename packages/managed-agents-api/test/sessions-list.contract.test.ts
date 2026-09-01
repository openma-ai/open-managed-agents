import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionsPort, sessionView, sessionWire } from "./session-fixtures";
import { buildSessionsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/sessions", () => {
  it("maps all official filters and returns a bidirectional cursor page", async () => {
    const listCalls: unknown[] = [];
    const port = makeSessionsPort({
      listSessions: async (query) => {
        listCalls.push(query);
        return {
          type: "page",
          page: {
            sessions: [sessionView],
            nextCursor: "session_page_02",
            previousCursor: "session_page_00",
          },
        };
      },
    });
    const api = buildSessionsTestApi(port);
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

    const page = await client.beta.sessions.list({
      limit: 25,
      page: "session_page_01",
      agent_id: sessionWire.agent.id,
      agent_version: 3,
      "created_at[gt]": "2026-08-01T00:00:00.000Z",
      "created_at[gte]": "2026-08-02T00:00:00.000Z",
      "created_at[lt]": "2026-09-01T00:00:00.000Z",
      "created_at[lte]": "2026-08-31T23:59:59.999Z",
      deployment_id: "deployment_01K33N1Z4B8JX7V0C2P5S9M6QA",
      include_archived: true,
      memory_store_id: "memory_store_01K33N2YR5W8C3T6Z0F1Q7P4BA",
      order: "asc",
      statuses: ["running", "idle"],
    });

    expect(listCalls).toEqual([
      {
        pageSize: 25,
        cursor: "session_page_01",
        agentId: sessionWire.agent.id,
        agentVersion: 3,
        createdAfter: "2026-08-01T00:00:00.000Z",
        createdAtOrAfter: "2026-08-02T00:00:00.000Z",
        createdBefore: "2026-09-01T00:00:00.000Z",
        createdAtOrBefore: "2026-08-31T23:59:59.999Z",
        deploymentId: "deployment_01K33N1Z4B8JX7V0C2P5S9M6QA",
        includeArchived: true,
        memoryStoreId: "memory_store_01K33N2YR5W8C3T6Z0F1Q7P4BA",
        order: "asc",
        statuses: ["running", "idle"],
      },
    ]);
    expect(page.data).toEqual([sessionWire]);
    expect(page.next_page).toBe("session_page_02");
    expect(page.prev_page).toBe("session_page_00");
  });
});
