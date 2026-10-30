// Node composition of the shared managed credential resolver behind the HTTP
// MCP proxy: a managed mcp_oauth credential is refreshed on 401 and the
// rotation survives a concurrent write to the same credential.
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

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

describe("Node MCP proxy with managed Vault credentials", () => {
  it("refreshes on 401 and keeps the rotation across a concurrent credential write", async () => {
    const root = await mkdtemp(join(tmpdir(), "oma-node-managed-mcp-"));
    dirs.push(root);
    const headers = {
      "x-api-key": "test-admin",
      "content-type": "application/json",
      "anthropic-beta": "managed-agents-2026-04-01",
    };
    let cp!: NodeControlPlane;
    const call = async (path: string, body?: unknown) => {
      const response = await cp.fetch(new Request(`http://cp${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      return { status: response.status, data: await response.json() as any };
    };
    let vaultId = "";
    let credentialId = "";
    const tokenRequests: string[] = [];
    const upstreamBearers: string[] = [];

    const upstream = createServer(async (request, response) => {
      if (request.url === "/token") {
        tokenRequests.push(await bodyOf(request));
        // A concurrent writer bumps the revision without rotating the token.
        const renamed = await call(`/v1/vaults/${vaultId}/credentials/${credentialId}`, {
          display_name: "renamed meanwhile",
        });
        expect(renamed.status, JSON.stringify(renamed.data)).toBe(200);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "fresh-access", refresh_token: "refresh-v2", expires_in: 3600 }));
        return;
      }
      await bodyOf(request);
      const bearer = request.headers.authorization ?? "";
      upstreamBearers.push(bearer);
      const ok = bearer === "Bearer fresh-access";
      response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(ok ? { jsonrpc: "2.0", id: 1, result: {} } : { error: "unauthorized" }));
    });
    const upstreamUrl = await listen(upstream);

    cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
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

    const serverUrl = `${upstreamUrl}/mcp`;
    const vault = await call("/v1/vaults", { display_name: "mcp" });
    vaultId = vault.data.id;
    const credential = await call(`/v1/vaults/${vaultId}/credentials`, {
      display_name: "docs",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: serverUrl,
        access_token: "stale-access",
        refresh: {
          client_id: "client",
          refresh_token: "refresh-v1",
          token_endpoint: `${upstreamUrl}/token`,
          token_endpoint_auth: { type: "none" },
        },
      },
    });
    expect(credential.status, JSON.stringify(credential.data)).toBe(201);
    credentialId = credential.data.id;
    upstreamBearers.length = 0;

    const env = await call("/v1/environments", {
      name: "sandbox",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    const agent = await call("/v1/agents", {
      name: "docs agent",
      model: "claude-sonnet-5-5",
      mcp_servers: [{ name: "docs", type: "url", url: serverUrl }],
      tools: [{ type: "mcp_toolset", mcp_server_name: "docs" }],
    });
    expect(agent.status, JSON.stringify(agent.data)).toBeLessThan(300);
    const session = await call("/v1/sessions", {
      agent: { type: "agent", id: agent.data.id, version: agent.data.version },
      environment_id: env.data.id,
      vault_ids: [vaultId],
    });
    expect(session.status, JSON.stringify(session.data)).toBeLessThan(300);

    const proxied = await cp.fetch(new Request(`http://cp/v1/oma/mcp-proxy/${session.data.id}/docs`, {
      method: "POST",
      headers: { ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(proxied.status, await proxied.clone().text()).toBe(200);
    expect(upstreamBearers).toEqual(["Bearer stale-access", "Bearer fresh-access"]);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toContain("refresh_token=refresh-v1");

    // The rotation was re-applied on the concurrent writer's revision.
    const stored = await call(`/v1/vaults/${vaultId}/credentials/${credentialId}`);
    expect(stored.data.display_name).toBe("renamed meanwhile");
    upstreamBearers.length = 0;
    const again = await cp.fetch(new Request(`http://cp/v1/oma/mcp-proxy/${session.data.id}/docs`, {
      method: "POST",
      headers: { ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }));
    expect(again.status).toBe(200);
    expect(upstreamBearers).toEqual(["Bearer fresh-access"]);
    expect(tokenRequests).toHaveLength(1);
  });
});
