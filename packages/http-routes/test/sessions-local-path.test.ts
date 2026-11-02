import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildSessionRoutes } from "../src/sessions";

describe("POST /sessions — github_repository local_path", () => {
  it("rejects relative local_path with 400", async () => {
    const create = vi.fn();
    const routes = buildSessionRoutes({
      services: {
        agents: {
          get: vi.fn(async () => ({
            id: "agent_local",
            runtime_binding: { runtime_id: "rt", acp_agent_id: "codex-acp" },
            model: "test",
            system: "sys",
            name: "Local",
            version: 1,
          })),
        },
        sessions: { create },
      },
      router: { init: vi.fn(), streamEvents: vi.fn() },
      localRuntimeEnvId: "env_local_runtime",
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tenant_id", "tenant_1");
      await next();
    });
    app.route("/sessions", routes);

    const response = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "agent_local",
        resources: [
          {
            type: "github_repository",
            url: "https://github.com/openma/example",
            local_path: "relative/path",
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "local_path must be an absolute filesystem path",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
