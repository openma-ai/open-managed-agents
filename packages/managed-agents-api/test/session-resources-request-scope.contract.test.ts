import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildSessionResourceRoutes } from "../src/routes/session-resources";
import { makeSessionResourcesPort } from "./session-resource-fixtures";

describe("Managed Agents API — request-scoped Session Resources port", () => {
  it("resolves the application port after auth scope is established", async () => {
    const api = new Hono<{ Variables: { workspaceId: string } }>();
    api.use("/v1/*", async (c, next) => {
      c.set("workspaceId", c.req.header("x-test-workspace") ?? "missing");
      await next();
    });
    api.route(
      "/v1/sessions",
      buildSessionResourceRoutes((c) => {
        const workspaceId = (c.var as { workspaceId: string }).workspaceId;
        return makeSessionResourcesPort({
          listSessionResources: async () => ({
            type: "page",
            page: {
              resources: [
                {
                  id: "sesrsc_scope",
                  type: "file",
                  createdAt: "2026-08-26T09:00:00.000Z",
                  fileId: "file_scope",
                  mountPath: `/workspace/${workspaceId}`,
                  updatedAt: "2026-08-26T09:00:00.000Z",
                },
              ],
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

    const first = await client.beta.sessions.resources.list("session_01", {}, {
      headers: { "x-test-workspace": "workspace_first" },
    });
    const second = await client.beta.sessions.resources.list("session_01", {}, {
      headers: { "x-test-workspace": "workspace_second" },
    });

    expect(first.data[0]?.mount_path).toBe("/workspace/workspace_first");
    expect(second.data[0]?.mount_path).toBe("/workspace/workspace_second");
  });
});
