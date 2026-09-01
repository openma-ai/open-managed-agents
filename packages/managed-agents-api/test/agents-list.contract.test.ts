import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { agentView, agentWire, makeAgentsPort } from "./fixtures";
import { buildAgentsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/agents", () => {
  it("maps official SDK filters and returns the official cursor page", async () => {
    const listCalls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        listAgents: async (query) => {
          listCalls.push(query);
          return {
            type: "page",
            page: {
              agents: [agentView],
              nextCursor: "page_02",
            },
          };
        },
      }),
    );
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

    const page = await client.beta.agents.list({
      limit: 2,
      page: "page_01",
      "created_at[gte]": "2026-08-01T00:00:00.000Z",
      "created_at[lte]": "2026-08-31T23:59:59.999Z",
      include_archived: true,
    });

    expect(listCalls).toEqual([
      {
        pageSize: 2,
        cursor: "page_01",
        createdAtOrAfter: "2026-08-01T00:00:00.000Z",
        createdAtOrBefore: "2026-08-31T23:59:59.999Z",
        includeArchived: true,
      },
    ]);
    expect(page.data).toEqual([agentWire]);
    expect(page.next_page).toBe("page_02");
  });

  it("maps an invalid application cursor outcome to the official SDK bad-request error", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        listAgents: async () => ({
          type: "invalid_request",
          message: "Invalid agents page cursor",
        }),
      }),
    );
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

    await expect(
      client.beta.agents.list({ page: "malformed" }),
    ).rejects.toMatchObject({
      status: 400,
      type: "invalid_request_error",
      error: {
        error: {
          type: "invalid_request_error",
          message: "Invalid agents page cursor",
        },
      },
    });
  });
});
