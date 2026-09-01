import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { agentView, agentWire, makeAgentsPort } from "./fixtures";
import { buildAgentsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/agents/:agent_id/archive", () => {
  it("maps the official SDK archive call to an application command", async () => {
    const archiveCalls: unknown[] = [];
    const archivedAt = "2026-08-26T01:00:00.000Z";
    const api = buildAgentsTestApi(
      makeAgentsPort({
        archiveAgent: async (command) => {
          archiveCalls.push(command);
          return {
            type: "archived",
            agent: { ...agentView, archivedAt, updatedAt: archivedAt },
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

    const result = await client.beta.agents.archive(agentWire.id);

    expect(archiveCalls).toEqual([{ agentId: agentWire.id }]);
    expect(result).toEqual({
      ...agentWire,
      archived_at: archivedAt,
      updated_at: archivedAt,
    });
  });

  it("maps the explicit application not-found result to the official SDK error", async () => {
    const api = buildAgentsTestApi(
      makeAgentsPort({
        archiveAgent: async () => ({ type: "not_found" }),
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

    await expect(client.beta.agents.archive("agent_missing")).rejects.toMatchObject({
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
});
