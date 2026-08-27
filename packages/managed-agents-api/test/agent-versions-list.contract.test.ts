import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { agentView, agentWire, makeAgentsPort } from "./fixtures";
import { buildAgentsTestApi } from "./test-api";

describe("Managed Agents API — GET /v1/agents/:agent_id/versions", () => {
  it("maps the official SDK versions request to its dedicated application query", async () => {
    const listCalls: unknown[] = [];
    const previousVersion = { ...agentView, version: 1 };
    const api = buildAgentsTestApi(
      makeAgentsPort({
        listAgentVersions: async (query) => {
          listCalls.push(query);
          return {
            type: "page",
            page: {
              agents: [previousVersion],
              nextCursor: null,
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

    const page = await client.beta.agents.versions.list(agentWire.id, {
      limit: 10,
      page: "version_page_01",
    });

    expect(listCalls).toEqual([
      {
        agentId: agentWire.id,
        pageSize: 10,
        cursor: "version_page_01",
      },
    ]);
    expect(page.data).toEqual([{ ...agentWire, version: 1 }]);
    expect(page.next_page).toBeNull();
  });

  it("maps an unknown agent to the official SDK not-found error", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        listAgentVersions: async () => ({ type: "not_found" }),
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
      client.beta.agents.versions.list("agent_missing"),
    ).rejects.toMatchObject({
      status: 404,
      type: "not_found_error",
      error: {
        error: {
          type: "not_found_error",
          message: expect.stringContaining("agent_missing"),
        },
      },
    });
  });

  it("maps an invalid versions cursor outcome to the official SDK bad-request error", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        listAgentVersions: async () => ({
          type: "invalid_request",
          message: "Invalid agent versions page cursor",
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
      client.beta.agents.versions.list(agentWire.id, { page: "malformed" }),
    ).rejects.toMatchObject({
      status: 400,
      type: "invalid_request_error",
      error: {
        error: {
          type: "invalid_request_error",
          message: "Invalid agent versions page cursor",
        },
      },
    });
  });
});
