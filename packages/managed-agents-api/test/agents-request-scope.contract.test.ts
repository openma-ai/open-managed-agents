import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildAgentRoutes } from "../src/routes/agents";
import { agentView, makeAgentsPort } from "./fixtures";

describe("Managed Agents API — request-scoped Agents port", () => {
  it("resolves the application Port after auth scope is established for each request", async () => {
    const api = new Hono<{ Variables: { workspaceId: string } }>();
    api.use("/v1/*", async (c, next) => {
      c.set("workspaceId", c.req.header("x-test-workspace") ?? "missing");
      await next();
    });
    api.route(
      "/v1/agents",
      buildAgentRoutes((c) => {
        const workspaceId = (c.var as { workspaceId: string }).workspaceId;
        return makeAgentsPort({
          listAgents: async () => ({
            type: "page",
            page: {
              agents: [{ ...agentView, name: workspaceId }],
              nextCursor: null,
            },
          }),
        });
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

    const first = await client.beta.agents.list(
      {},
      { headers: { "x-test-workspace": "workspace_first" } },
    );
    const second = await client.beta.agents.list(
      {},
      { headers: { "x-test-workspace": "workspace_second" } },
    );

    expect(first.data[0]?.name).toBe("workspace_first");
    expect(second.data[0]?.name).toBe("workspace_second");
  });
});
