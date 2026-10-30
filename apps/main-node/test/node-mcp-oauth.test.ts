// Node composition of /v1/oma/oauth: the browser MCP OAuth flow writes a
// managed mcp_oauth credential (refresh metadata included) that the Node MCP
// proxy then injects and refreshes through the shared resolver.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";

const servers: ReturnType<typeof createServer>[] = [];
const planes: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(planes.splice(0).map((cp) => cp.stop("test")));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function bodyOf(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

describe("Node /v1/oma/oauth", () => {
  it("stores a managed mcp_oauth credential the MCP proxy injects and refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "oma-node-mcp-oauth-"));
    dirs.push(root);
    const tokenBodies: URLSearchParams[] = [];
    const bearers: string[] = [];
    let origin = "";
    const provider = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", origin);
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
        });
      }
      if (url.pathname === "/register") {
        await bodyOf(request);
        return json(201, { client_id: "registered-client" });
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await bodyOf(request));
        tokenBodies.push(body);
        return body.get("grant_type") === "authorization_code"
          ? json(200, { access_token: "first-access", refresh_token: "refresh-1", expires_in: 3600 })
          : json(200, { access_token: "second-access", refresh_token: "refresh-2", expires_in: 3600 });
      }
      if (url.pathname === "/mcp") {
        await bodyOf(request);
        const bearer = request.headers.authorization ?? "";
        bearers.push(bearer);
        // The first token is accepted by the post-connect probe, then expires.
        const ok = bearer === "Bearer second-access" || (bearer === "Bearer first-access" && bearers.length === 1);
        return json(ok ? 200 : 401, ok ? { jsonrpc: "2.0", id: 1, result: {} } : { error: "expired" });
      }
      json(404, {});
    });
    servers.push(provider);
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const serverUrl = `${origin}/mcp`;

    const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
      NODE_ENV: "test", AUTH_DISABLED: "0", API_KEY: "test-admin",
      PLATFORM_ROOT_SECRET: "test-root-secret-not-production",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
      MEMORY_QUEUE: "disabled", LOG_LEVEL: "silent",
      DATABASE_PATH: join(root, "db.sqlite"), AUTH_DATABASE_PATH: join(root, "auth.sqlite"),
      SANDBOX_WORKDIR: join(root, "sandboxes"), MEMORY_BLOB_DIR: join(root, "memories"),
      FILES_BLOB_DIR: join(root, "files"), SESSION_OUTPUTS_DIR: join(root, "outputs"),
      ANTHROPIC_API_KEY: "unused",
    })));
    planes.push(cp);
    const headers = { "x-api-key": "test-admin", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" };
    const call = async (path: string, body?: unknown) => {
      const response = await cp.fetch(new Request(`http://cp${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      return { status: response.status, data: await response.json() as any };
    };

    const vault = await call("/v1/vaults", { display_name: "oauth" });
    const authorize = await cp.fetch(new Request(
      `http://cp/v1/oma/oauth/authorize?${new URLSearchParams({
        mcp_server_url: serverUrl,
        vault_id: vault.data.id,
        redirect_uri: "http://console.test/vaults",
      })}`,
      { headers },
    ));
    expect(authorize.status, await authorize.clone().text()).toBe(302);
    const location = new URL(authorize.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${origin}/authorize`);
    expect(location.searchParams.get("client_id")).toBe("registered-client");
    expect(location.searchParams.get("redirect_uri")).toBe("http://cp/v1/oma/oauth/callback");

    const callback = await cp.fetch(new Request(
      `http://cp/v1/oma/oauth/callback?${new URLSearchParams({ code: "auth-code", state: location.searchParams.get("state")! })}`,
      { headers },
    ));
    const page = await callback.text();
    expect(callback.status, page).toBe(200);
    expect(page).toContain("oauth_complete");
    expect(page).not.toContain("first-access");
    expect(tokenBodies[0]!.get("code")).toBe("auth-code");
    expect(tokenBodies[0]!.get("code_verifier")).toBeTruthy();

    const listed = await call(`/v1/vaults/${vault.data.id}/credentials`);
    expect(listed.data.data).toHaveLength(1);
    expect(listed.data.data[0].auth).toMatchObject({
      type: "mcp_oauth",
      mcp_server_url: serverUrl,
      refresh: { client_id: "registered-client", token_endpoint: `${origin}/token`, token_endpoint_auth: { type: "none" } },
    });
    expect(JSON.stringify(listed.data)).not.toContain("refresh-1");

    // A forged or replayed-elsewhere state is refused.
    const forged = await cp.fetch(new Request("http://cp/v1/oma/oauth/callback?code=x&state=forged", { headers }));
    expect(forged.status).toBe(400);

    const env = await call("/v1/environments", { name: "sandbox", config: { type: "cloud", networking: { type: "unrestricted" } } });
    const agent = await call("/v1/agents", {
      name: "oauth agent",
      model: "claude-sonnet-5-5",
      mcp_servers: [{ name: "svc", type: "url", url: serverUrl }],
      tools: [{ type: "mcp_toolset", mcp_server_name: "svc" }],
    });
    const session = await call("/v1/sessions", {
      agent: { type: "agent", id: agent.data.id, version: agent.data.version },
      environment_id: env.data.id,
      vault_ids: [vault.data.id],
    });
    expect(session.status, JSON.stringify(session.data)).toBeLessThan(300);
    const proxied = await cp.fetch(new Request(`http://cp/v1/oma/mcp-proxy/${session.data.id}/svc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(proxied.status, await proxied.clone().text()).toBe(200);
    expect(bearers.slice(1)).toEqual(["Bearer first-access", "Bearer second-access"]);
    expect(tokenBodies[1]!.get("grant_type")).toBe("refresh_token");
    expect(tokenBodies[1]!.get("refresh_token")).toBe("refresh-1");
  });
});
