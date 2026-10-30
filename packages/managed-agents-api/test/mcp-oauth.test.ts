import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { McpOAuthApplicationService, McpOAuthCliService, CredentialsApplicationService, type McpOAuthPort } from "@open-managed-agents/managed-agents-application";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import { WebCryptoAesGcm } from "../../integrations-adapters-cf/src/crypto";
import { buildMcpOAuthRoutes, buildMcpOAuthCliRoutes, buildMcpOAuthCliCallback } from "../src/index";

function harness() {
  const store = new MemoryCredentialStore();
  let ids = 0;
  let exchanges = 0;
  const credentials = new CredentialsApplicationService({
    workspaceId: "ws_1", store,
    vaults: { find: async ({ vaultId }) => vaultId === "vlt_1" ? { id: vaultId, archivedAt: null, createdAt: "", displayName: "v", metadata: {}, updatedAt: "" } : null },
    validation: { validate: async () => { throw new Error("unused"); } },
    clock: { now: () => new Date("2026-09-01T00:00:00.000Z") },
    ids: { nextCredentialId: () => `cred_${++ids}` },
  });
  const oauth: McpOAuthPort = {
    discover: async () => ({ type: "discovered", metadata: { resource: "https://mcp.example.test/mcp", issuer: "https://provider.example.test", authorizationEndpoint: "https://provider.example.test/authorize", tokenEndpoint: "https://provider.example.test/token", scopes: [] } }),
    client: async () => ({ type: "client", client: { clientId: "client" } }),
    exchangeCode: async () => { exchanges++; return { type: "issued", tokens: { accessToken: "private-access", refreshToken: "private-refresh", expiresAt: null } }; },
    probe: async () => ({ ok: false, reason: "http_401" }),
  };
  const service = new McpOAuthApplicationService({ workspaceId: "ws_1", credentials, oauth, pkce: { create: async () => ({ verifier: "verifier", challenge: "challenge" }) }, cipher: new WebCryptoAesGcm("test-root-secret-not-production", "test.mcp.oauth"), clock: { now: () => new Date("2026-09-01T00:00:00.000Z") }, log: { warn: () => {} } });
  let serial = 0;
  const rows = new Map<string, string>();
  const secrets = { randomToken: () => `random_${++serial}`, hash: async (s: string) => `hash:${s}` };
  const cli = new McpOAuthCliService({ application: () => service, cipher: new WebCryptoAesGcm("test-root-secret-not-production", "test.mcp.cli"), secrets, clock: { now: () => new Date("2026-09-01T00:00:00.000Z") }, store: {
    create: async (id, value) => { rows.set(id, value); }, read: async (id) => rows.get(id) ?? null,
    compareAndSwap: async (id, expected, value) => { if (rows.get(id) !== expected) return false; rows.set(id, value); return true; },
    consume: async (id, expected) => { if (rows.get(id) !== expected) return false; rows.delete(id); return true; },
  } });
  const app = new Hono<{ Variables: { user_id?: string; tenant_id: string } }>();
  app.use("/v1/oma/oauth/callback", buildMcpOAuthCliCallback(cli));
  app.use("*", async (c, next) => { c.set("tenant_id", "ws_1"); const user = c.req.header("x-test-user"); if (user) c.set("user_id", user); await next(); });
  app.route("/v1/oma/oauth/cli", buildMcpOAuthCliRoutes(cli, secrets));
  app.route("/v1/oma/oauth", buildMcpOAuthRoutes(service, { consoleOrigins: ["https://console.example.test"] }));
  const post = (body: unknown, user = "user_1") => app.request("https://cp.example.test/v1/oma/oauth/authorize", { method: "POST", headers: { "content-type": "application/json", "x-test-user": user }, body: JSON.stringify(body) });
  return { app, post, credentials, oauth, exchanges: () => exchanges };
}

const body = { vault_id: "vlt_1", mcp_server_url: "https://mcp.example.test/mcp" };

describe("MCP OAuth routes", () => {
  it("lets CLI browser callback complete without cookies but requires the original key and claim secret to collect", async () => {
    const h = harness();
    const post = (path: string, body: unknown, key = "original-key") => h.app.request(`https://cp.example.test/v1/oma/oauth/cli/${path}`, { method: "POST", headers: { "x-api-key": key, "x-test-user": "user_1", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("authorize", { ...body, redirect_uri: "http://localhost:3000/callback" })).status).toBe(400);
    const started = await post("authorize", { ...body, client_id: "pinned", client_secret: "private-secret" });
    expect(started.status).toBe(200);
    const data = await started.json() as { authorization_url: string; flow_id: string; claim_token: string };
    expect(data.authorization_url).not.toContain(data.claim_token);
    expect(data.authorization_url).not.toContain("private-secret");
    const state = new URL(data.authorization_url).searchParams.get("state")!;
    const claim = { flow_id: data.flow_id, claim_token: data.claim_token };
    expect((await (await post("result", claim)).json())).toEqual({ status: "pending" });
    const callback = await h.app.request(`https://cp.example.test/v1/oma/oauth/callback?${new URLSearchParams({ state, code: "c" })}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).not.toContain("private-access");
    expect((await post("result", claim, "other-key")).status).toBe(400);
    expect(await (await post("result", claim)).json()).toEqual({ status: "ready", credential_id: "cred_1" });
    expect((await post("result", claim)).status).toBe(400);
  });

  it("accepts secrets only in POST JSON and returns a sealed authorization URL without a redirect", async () => {
    const h = harness();
    const legacy = await h.app.request("https://cp.example.test/v1/oma/oauth/authorize?client_secret=private-secret");
    expect(legacy.status).toBe(404);
    const response = await h.post({ ...body, client_id: "pinned-client", client_secret: "private-secret" });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const data = await response.json() as { authorization_url: string };
    const url = new URL(data.authorization_url);
    expect(url.searchParams.get("client_id")).toBe("pinned-client");
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(data.authorization_url).not.toContain("private-secret");
  });

  it.each(["https://untrusted.example.test/path", "https://console.example.test.attacker.test/", "javascript:alert(1)", "not a URL"])("refuses untrusted return URL %s", async (redirect_uri) => {
    const h = harness();
    expect((await h.post({ ...body, redirect_uri })).status).toBe(400);
  });

  it.each(["https://cp.example.test/vaults/vlt_1", "https://console.example.test/vaults/vlt_1"])("targets only the validated return origin %s", async (redirect_uri) => {
    const h = harness();
    const response = await h.post({ ...body, redirect_uri });
    expect(response.status).toBe(200);
    const { authorization_url } = await response.json() as { authorization_url: string };
    const state = new URL(authorization_url).searchParams.get("state")!;
    const callback = await h.app.request(`https://cp.example.test/v1/oma/oauth/callback?${new URLSearchParams({ state, code: "code" })}`, { headers: { "x-test-user": "user_1" } });
    expect(callback.status).toBe(200);
    const page = await callback.text();
    expect(page).toContain(`postMessage(msg, ${JSON.stringify(new URL(redirect_uri).origin)})`);
    expect(page).not.toContain('postMessage(msg, "*")');
    expect(page).toContain('"probe_reason":"http_401"');
    expect(page).not.toContain("private-access");
  });

  it("binds state to the authenticated user_id, including user versus API-key context", async () => {
    const h = harness();
    const { authorization_url } = await (await h.post(body)).json() as { authorization_url: string };
    const state = new URL(authorization_url).searchParams.get("state")!;
    for (const user of ["user_2", ""]) {
      const callback = await h.app.request(`https://cp.example.test/v1/oma/oauth/callback?${new URLSearchParams({ state, code: "code" })}`, { headers: user ? { "x-test-user": user } : {} });
      expect(callback.status).toBe(400);
    }
    expect(h.exchanges()).toBe(0);
    const listed = await h.credentials.listCredentials({ vaultId: "vlt_1" });
    expect(listed).toMatchObject({ type: "page", page: { credentials: [] } });
  });

  it("contains unexpected application failures instead of passing internal URLs to the platform error handler", async () => {
    const h = harness();
    h.oauth.discover = async () => { throw new Error("https://private.example.test/secret upstream body"); };
    h.app.onError((error, c) => c.text(error.message, 500));
    const response = await h.post(body);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("private.example.test");
    expect(text).not.toContain("upstream body");
  });

  it("does not echo provider error_description, URLs or malformed error values", async () => {
    const h = harness();
    const callback = await h.app.request(`https://cp.example.test/v1/oma/oauth/callback?${new URLSearchParams({ error: "https://private.example.test/secret", error_description: "sensitive upstream body" })}`);
    expect(callback.status).toBe(400);
    const page = await callback.text();
    expect(page).not.toContain("private.example.test");
    expect(page).not.toContain("sensitive upstream body");
  });
});
