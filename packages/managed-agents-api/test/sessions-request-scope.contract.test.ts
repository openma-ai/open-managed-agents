import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildSessionRoutes } from "../src/routes/sessions";
import { makeSessionsPort, sessionView } from "./session-fixtures";

describe("Managed Agents API — request-scoped Sessions port", () => {
  it("resolves the application port after auth scope is established", async () => {
    const api = new Hono<{ Variables: { workspaceId: string } }>();
    api.use("/v1/*", async (c, next) => {
      c.set("workspaceId", c.req.header("x-test-workspace") ?? "missing");
      await next();
    });
    api.route(
      "/v1/sessions",
      buildSessionRoutes((c) => {
        const workspaceId = (c.var as { workspaceId: string }).workspaceId;
        return makeSessionsPort({
          listSessions: async () => ({
            type: "page",
            page: {
              sessions: [{ ...sessionView, title: workspaceId }],
              nextCursor: null,
              previousCursor: null,
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

    const first = await client.beta.sessions.list(
      {},
      { headers: { "x-test-workspace": "workspace_first" } },
    );
    const second = await client.beta.sessions.list(
      {},
      { headers: { "x-test-workspace": "workspace_second" } },
    );

    expect(first.data[0]?.title).toBe("workspace_first");
    expect(second.data[0]?.title).toBe("workspace_second");
  });
});
