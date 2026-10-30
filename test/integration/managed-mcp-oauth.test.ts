// @ts-nocheck
// Cloudflare composition of /v1/oma/oauth: the browser MCP OAuth flow writes
// a managed mcp_oauth Vault credential through the shared application service.
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const HEADERS = {
  "x-api-key": "test-key",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};
const PROVIDER = "https://mcp-oauth.provider.test";

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, { redirect: "manual", ...init }));
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installProvider(tokenBodies: URLSearchParams[]) {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== PROVIDER) return originalFetch(input, init);
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
        return Response.json({ resource: `${PROVIDER}/mcp`, authorization_servers: [PROVIDER] });
      case "/.well-known/oauth-authorization-server":
        return Response.json({
          issuer: PROVIDER,
          authorization_endpoint: `${PROVIDER}/authorize`,
          token_endpoint: `${PROVIDER}/token`,
          registration_endpoint: `${PROVIDER}/register`,
        });
      case "/register":
        return Response.json({ client_id: "cf-registered" }, { status: 201 });
      case "/token":
        tokenBodies.push(new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer())));
        return Response.json({ access_token: "cf-access", refresh_token: "cf-refresh", expires_in: 3600 });
      case "/mcp":
        return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      default:
        return new Response("not found", { status: 404 });
    }
  };
}

describe("managed MCP OAuth (Cloudflare)", () => {
  it("authorizes and stores a managed mcp_oauth credential with refresh metadata", async () => {
    const tokenBodies: URLSearchParams[] = [];
    installProvider(tokenBodies);
    const vault = await (await api("/v1/vaults", {
      method: "POST", headers: HEADERS, body: JSON.stringify({ display_name: "oauth" }),
    })).json();

    const authorize = await api("/v1/oma/oauth/authorize", { method: "POST", headers: HEADERS, body: JSON.stringify({
      mcp_server_url: `${PROVIDER}/mcp`,
      vault_id: vault.id,
      redirect_uri: "http://localhost/console",
    }) });
    expect(authorize.status, await authorize.clone().text()).toBe(200);
    const location = new URL((await authorize.json()).authorization_url);
    expect(location.searchParams.get("client_id")).toBe("cf-registered");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/v1/oma/oauth/callback");

    const callback = await api(`/v1/oma/oauth/callback?${new URLSearchParams({
      code: "cf-code",
      state: location.searchParams.get("state"),
    })}`, { headers: HEADERS });
    const page = await callback.text();
    expect(callback.status, page).toBe(200);
    expect(page).toContain("oauth_complete");
    expect(page).not.toContain("cf-access");
    expect(tokenBodies[0].get("code_verifier")).toBeTruthy();

    const listed = await (await api(`/v1/vaults/${vault.id}/credentials`, { headers: HEADERS })).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].auth).toMatchObject({
      type: "mcp_oauth",
      mcp_server_url: `${PROVIDER}/mcp`,
      refresh: { client_id: "cf-registered", token_endpoint: `${PROVIDER}/token` },
    });
    expect(JSON.stringify(listed)).not.toContain("cf-refresh");
  });

  it("rejects a missing Vault, missing parameters and a forged state", async () => {
    installProvider([]);
    const missing = await api("/v1/oma/oauth/authorize", { method: "POST", headers: HEADERS, body: JSON.stringify({ mcp_server_url: `${PROVIDER}/mcp`, vault_id: "vlt_missing" }) });
    expect(missing.status).toBe(404);
    expect((await api("/v1/oma/oauth/authorize", { method: "POST", headers: HEADERS })).status).toBe(400);
    expect((await api("/v1/oma/oauth/authorize?client_secret=secret", { headers: HEADERS })).status).toBe(404);
    expect((await api("/v1/oma/oauth/authorize", { method: "POST", headers: HEADERS, body: JSON.stringify({ mcp_server_url: `${PROVIDER}/mcp`, vault_id: "vlt_missing", redirect_uri: "https://untrusted.example.test" }) })).status).toBe(400);
    expect((await api("/v1/oma/oauth/callback?code=x&state=forged", { headers: HEADERS })).status).toBe(400);
  });
});
