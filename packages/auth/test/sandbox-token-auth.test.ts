// The sandbox token step of the shared auth middleware (#561): 401 only for a
// definite rejection, 503 (retry-after) when a credential could not be
// checked, and no fallback to other credentials once a sandbox token is presented.
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware, type SandboxTokenAuthDecision } from "../src/index";

function app(decide: () => Promise<SandboxTokenAuthDecision>, overrides: Record<string, unknown> = {}) {
  const deps = {
    disabled: false,
    resolveSession: vi.fn(async () => null),
    resolveApiKey: vi.fn(async (key: string) => (key === "workspace-key" ? { tenantId: "ws_key" } : null)),
    resolveBearerToken: vi.fn(async () => null),
    resolveSandboxToken: vi.fn(decide),
    defaultTenantForUser: vi.fn(async () => null),
    hasMembership: vi.fn(async () => true),
    ensureTenantForUser: vi.fn(async () => "ws"),
    ...overrides,
  };
  const hono = new Hono();
  hono.use("*", createAuthMiddleware(deps as never));
  hono.all("*", (c) => c.json({ tenant: c.get("tenant_id"), credential: c.get("auth_credential") ?? null }));
  return { hono, deps };
}
const inference = "/v1/oma/inference-proxy/sess/anthropic/v1/messages";
const accepted: SandboxTokenAuthDecision = {
  type: "accepted", transport: "bearer",
  resolution: { tenantId: "ws_token", credential: { type: "environment_work_session", environmentId: "env", sessionId: "sess", workId: "exe", claimedAt: "2026-01-01T00:00:00.000Z", generation: 1 } },
};

describe("auth middleware: sandbox token (resolveSandboxToken)", () => {
  it.each([
    ["unavailable", async (): Promise<SandboxTokenAuthDecision> => ({ type: "unavailable", error: new Error("db down") })],
    ["thrown", async (): Promise<SandboxTokenAuthDecision> => { throw new Error("db down"); }],
  ] as const)("could not check (%s) = 503 with retry-after, and no other credential is tried", async (_name, decide) => {
    const { hono, deps } = app(decide);
    for (const path of [inference, "/v1/oma/mcp-proxy/sess/srv", "/v1/files/file_01"]) {
      const response = await hono.request(path, { method: "POST", headers: { authorization: "Bearer oma_sbx_x", "x-api-key": "workspace-key" } });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.json()).toEqual({ error: "Credential could not be checked" });
    }
    expect(deps.resolveApiKey).not.toHaveBeenCalled();
    expect(deps.resolveBearerToken).not.toHaveBeenCalled();
  });

  it("rejected = 401 on both envelopes, and no fallback to an API key on the same request", async () => {
    const { hono, deps } = app(async () => ({ type: "rejected" }));
    const official = await hono.request("/v1/files/file_01", { headers: { authorization: "Basic eA==", "x-api-key": "workspace-key" } });
    expect(official.status).toBe(401);
    expect(await official.json()).toEqual({ type: "error", error: { type: "authentication_error", message: "Invalid sandbox token" } });
    const oma = await hono.request(inference, { method: "POST", headers: { authorization: "Bearer oma_sbx_x" } });
    expect(oma.status).toBe(401);
    expect(await oma.json()).toEqual({ error: "Invalid sandbox token" });
    expect(deps.resolveApiKey).not.toHaveBeenCalled();
  });

  it("accepted sets the token's tenant and Session credential; the request passes", async () => {
    const { hono, deps } = app(async () => accepted);
    const response = await hono.request(inference, { method: "POST", headers: { authorization: "Bearer oma_sbx_x" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenant: "ws_token", credential: accepted.type === "accepted" ? accepted.resolution.credential : null });
    expect(deps.resolveSandboxToken).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path: inference }));
    expect(deps.resolveApiKey).not.toHaveBeenCalled();
  });

  it("absent (not a sandbox token) falls through to the other credentials", async () => {
    const { hono } = app(async () => ({ type: "absent" }));
    expect((await hono.request("/v1/agents", { headers: { "x-api-key": "workspace-key" } })).status).toBe(200);
    expect((await hono.request("/v1/agents", { headers: { "x-api-key": "wrong" } })).status).toBe(401);
  });

  it("a sealed bearer whose check throws (resolveBearerToken) = 503 on the model gateway and on the API, not 401", async () => {
    const { hono, deps } = app(async () => ({ type: "absent" }), { resolveBearerToken: vi.fn(async () => { throw new Error("db down"); }) });
    for (const [path, headers] of [
      [inference, { authorization: "Bearer sk-ant-req-v1.sealed" }],
      [inference, { "x-api-key": "sk-ant-req-v1.sealed" }],
      ["/v1/sessions/sess", { authorization: "Bearer sk-ant-req-v1.sealed" }],
    ] as const) {
      const response = await hono.request(path, { method: "POST", headers });
      expect(response.status, path).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
    }
    expect(deps.resolveApiKey).not.toHaveBeenCalled();
  });
});
