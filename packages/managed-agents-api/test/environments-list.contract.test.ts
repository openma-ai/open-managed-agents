import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { buildEnvironmentsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/environments", () => {
  it("maps cursor and include_archived query parameters", async () => {
    const listCalls: unknown[] = [];
    const port = makeEnvironmentsPort({
      listEnvironments: async (query) => {
        listCalls.push(query);
        return {
          type: "page",
          page: {
            environments: [
              {
                id: "env_list_01",
                archivedAt: null,
                config: { type: "self_hosted" },
                createdAt: "2026-08-26T08:30:00.000Z",
                description: null,
                metadata: {},
                name: "runner",
                updatedAt: "2026-08-26T08:30:00.000Z",
              },
            ],
            nextCursor: "environment_page_02",
          },
        };
      },
    });
    const api = buildEnvironmentsTestApi(port);
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

    const page = await client.beta.environments.list({
      limit: 15,
      page: "environment_page_01",
      include_archived: true,
    });

    expect(listCalls).toEqual([
      {
        pageSize: 15,
        cursor: "environment_page_01",
        includeArchived: true,
      },
    ]);
    expect(page.data[0]).toMatchObject({
      id: "env_list_01",
      type: "environment",
    });
    expect(page.next_page).toBe("environment_page_02");
  });
});
