import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createAuthMiddleware } from "../src/index";

function dependencies() {
  return {
    disabled: false,
    resolveSession: vi.fn(async () => null),
    resolveApiKey: vi.fn(async (token: string) =>
      token === "environment-key"
        ? { tenantId: "workspace_environment" }
        : null,
    ),
    resolveBearerToken: vi.fn(async ({ token, path }: { token: string; path: string }) =>
      token === "session-token" && path === "/v1/sessions/session_01"
        ? { tenantId: "workspace_session" }
        : null,
    ),
    defaultTenantForUser: vi.fn(async () => null),
    hasMembership: vi.fn(async () => false),
    ensureTenantForUser: vi.fn(async () => "workspace_default"),
  };
}

describe("managed worker bearer authentication", () => {
  it("accepts a scoped session bearer resolution before the API-key fallback", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/sessions/:sessionId", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );

    const response = await app.request("/v1/sessions/session_01", {
      headers: { Authorization: "Bearer session-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "workspace_session" });
    expect(deps.resolveApiKey).not.toHaveBeenCalled();
  });

  it("accepts an existing workspace API key as the official environment bearer", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/environments/:environmentId/work/poll", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );

    const response = await app.request("/v1/environments/env_01/work/poll", {
      headers: { Authorization: "Bearer environment-key" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "workspace_environment" });
    expect(deps.resolveBearerToken).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/environments/env_01/work/poll",
      token: "environment-key",
    });
  });

  it("rejects an unresolved bearer without falling through to cookie auth", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/sessions/:sessionId", (context) => context.json({ ok: true }));

    const response = await app.request("/v1/sessions/session_01", {
      headers: { Authorization: "Bearer invalid" },
    });

    expect(response.status).toBe(401);
    expect(deps.resolveSession).not.toHaveBeenCalled();
  });
});
