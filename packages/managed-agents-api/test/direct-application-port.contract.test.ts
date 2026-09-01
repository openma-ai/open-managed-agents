import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildAgentRoutes } from "../src/index";
import { agentView, makeAgentsPort } from "./fixtures";

describe("Managed Agents API direct application Port composition", () => {
  it("serves the official SDK without requiring a request-scoped resolver", async () => {
    const port = makeAgentsPort({
      listAgents: async () => ({
        type: "page",
        page: { agents: [agentView], nextCursor: null },
      }),
    });
    const api = new Hono().route("/v1/agents", buildAgentRoutes(port));
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

    const page = await client.beta.agents.list();

    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: agentView.id,
      type: "agent",
    });
  });
});
