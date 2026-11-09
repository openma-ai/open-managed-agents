import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlCredentialStore } from "../../../packages/credential-store-sql/src/index";
import { SqlVaultStore } from "../../../packages/vault-store-sql/src/index";
import { createLegacySessionMcpProxy } from "../../../packages/control-plane-node/src/lib/legacy-session-mcp-proxy";
import { createSqliteCredentialService } from "../../../packages/credentials-store/src/index";
import { createSqliteSessionService } from "../../../packages/sessions-store/src/index";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";

const planes: NodeControlPlane[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const dirs: string[] = [];
const headers = {
  "x-api-key": "test-admin",
  "content-type": "application/json",
  "anthropic-beta": "managed-agents-2026-04-01",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(planes.splice(0).map(cp => cp.stop("test")));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const seen: Array<{ headers: IncomingHttpHeaders; method: string }> = [];
  let upstreamStatus = 200;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    seen.push({ headers: request.headers, method: rpc.method });
    const result = rpc.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "public", version: "1" } }
      : rpc.method === "tools/list"
        ? { tools: ["echo", "hidden", "other"].map(name => ({ name, inputSchema: { type: "object" } })) }
        : { content: [{ type: "text", text: rpc.params.arguments.text }] };
    response.writeHead(upstreamStatus, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const root = await mkdtemp(join(tmpdir(), "oma-mcp-anonymous-"));
  dirs.push(root);
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
  async function call(path: string, body: unknown, method = "POST") {
    const response = await cp.fetch(new Request(`http://cp${path}`, {
      method, headers, ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }),
    }));
    const data = await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBeLessThan(300);
    return data;
  }
  const env = await call("/v1/environments", {
    name: "sandbox", config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  async function session(vaultIds: string[] = [], legacy = false, selected = false) {
    const prefix = legacy ? "/v1/oma" : "/v1";
    const agent = await call(`${prefix}/agents`, {
      name: "public MCP", model: "deepseek-flash", system: "Use echo.",
      mcp_servers: [{ name: "public", type: "url", url: serverUrl }],
      tools: [{ type: "mcp_toolset", mcp_server_name: "public", default_config: { enabled: !selected }, configs: [{ name: "echo", enabled: true }] }],
    });
    return call(`${prefix}/sessions`, {
      agent: legacy ? agent.id : { type: "agent", id: agent.id, version: agent.version },
      environment_id: env.id, vault_ids: vaultIds,
    });
  }
  const legacyBinding = createLegacySessionMcpProxy({
    sessions: createSqliteSessionService({ db: cp.components.database.drizzle }),
    credentials: createSqliteCredentialService({ db: cp.components.database.drizzle }),
    log: { info: () => undefined, warn: () => undefined },
  });
  function proxy(sessionId: string, method = "tools/list", serverName = "public", requestHeaders: Record<string, string> = headers, binding = false, toolName = "echo") {
    const params = method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "regression", version: "1" } }
      : method === "tools/call" ? { name: toolName, arguments: { text: "hello" } } : {};
    const request = new Request(`http://cp/v1/oma/mcp-proxy/${sessionId}/${serverName}`, {
      method: "POST", headers: {
        ...requestHeaders,
        ...(binding && { "x-oma-tenant": "default", "x-oma-session": sessionId, "x-oma-mcp-server": serverName }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return binding ? legacyBinding.fetch(request) : cp.fetch(request);
  }
  async function credential() {
    const vault = await call("/v1/vaults", { display_name: "mcp" });
    const credential = await call(`/v1/vaults/${vault.id}/credentials`, {
      auth: { type: "static_bearer", mcp_server_url: serverUrl, token: "vault-token" },
    });
    return { vault, credential };
  }
  return { cp, call, session, proxy, credential, seen, setStatus: (status: number) => { upstreamStatus = status; } };
}

describe("Node MCP proxy anonymous access (#527)", () => {
  it.each(["managed HTTP", "legacy HTTP", "legacy binding"])("initializes, lists and calls tools without Vaults via %s", async mode => {
    const f = await setup();
    const session = await f.session([], mode !== "managed HTTP");
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const response = await f.proxy(session.id, method, "public", {
        ...headers, authorization: "Bearer test-admin", cookie: "session=private",
        "proxy-authorization": "Basic private", "x-oma-tenant": "spoofed",
      }, mode === "legacy binding");
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json() as any;
      if (method === "tools/list") expect(body.result.tools[0].name).toBe("echo");
      if (method === "tools/call") expect(body.result.content[0].text).toBe("hello");
    }
    expect(f.seen.map(request => request.method)).toEqual(["initialize", "tools/list", "tools/call"]);
    for (const request of f.seen) {
      for (const name of ["authorization", "x-api-key", "cookie", "proxy-authorization", "x-oma-tenant"]) {
        expect(request.headers[name], name).toBeUndefined();
      }
    }
  });

  it("rejects unauthenticated callers, unknown Sessions, undeclared targets and another tenant's Session", async () => {
    const f = await setup();
    const session = await f.session();
    expect((await f.proxy(session.id, "tools/list", "public", { ...headers, "x-api-key": "wrong" })).status).toBe(401);
    expect((await f.proxy("missing")).status).toBe(403);
    expect((await f.proxy(session.id, "tools/list", "undeclared")).status).toBe(403);
    await f.cp.components.database.sql.prepare("UPDATE managed_sessions SET workspace_id = ? WHERE id = ?")
      .bind("other-tenant", session.id).run();
    expect((await f.proxy(session.id)).status).toBe(403);
    expect(f.seen).toEqual([]);
  });

  it("rejects archived Sessions before allowing anonymous access", async () => {
    const f = await setup();
    const session = await f.session();
    await f.call(`/v1/sessions/${session.id}/archive`, {});
    expect((await f.proxy(session.id)).status).toBe(403);
    expect(f.seen).toEqual([]);
  });

  it.each(["archived", "deleted"])("does not send anonymously after a credential is %s", async state => {
    const f = await setup();
    const { vault, credential } = await f.credential();
    const session = await f.session([vault.id]);
    expect((await f.proxy(session.id)).status).toBe(200);
    expect(f.seen.at(-1)?.headers.authorization).toBe("Bearer vault-token");
    const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`;
    await f.call(state === "archived" ? `${path}/archive` : path, {}, state === "archived" ? "POST" : "DELETE");
    f.seen.length = 0;
    expect((await f.proxy(session.id)).status).toBe(403);
    expect(f.seen).toEqual([]);
  });

  it.each(["credentials", "vaults"])("does not send anonymously when the %s store fails", async store => {
    const f = await setup();
    const { vault } = await f.credential();
    const session = await f.session([vault.id]);
    const read = store === "credentials"
      ? vi.spyOn(SqlCredentialStore.prototype, "list")
      : vi.spyOn(SqlVaultStore.prototype, "find");
    read.mockRejectedValue(new Error("store unavailable"));
    expect((await f.proxy(session.id)).status).toBe(500);
    expect(read).toHaveBeenCalled();
    expect(f.seen).toEqual([]);
  });

  it("does not retry a rejected Vault bearer anonymously", async () => {
    const f = await setup();
    const { vault } = await f.credential();
    const session = await f.session([vault.id]);
    f.setStatus(401);
    expect((await f.proxy(session.id)).status).toBe(401);
    expect(f.seen.map(request => request.headers.authorization)).toEqual(["Bearer vault-token"]);
  });
});


describe("Node MCP tool selection (#568)", () => {
  it.each(["managed HTTP", "legacy HTTP", "legacy binding"])("enforces selection through %s", async mode => {
    const f = await setup();
    const session = await f.session([], mode !== "managed HTTP", true);
    const list = await f.proxy(session.id, "tools/list", "public", headers, mode === "legacy binding");
    expect((await list.json() as any).result.tools.map((t: any) => t.name)).toEqual(["echo"]);
    const blocked = await f.proxy(session.id, "tools/call", "public", headers, mode === "legacy binding", "hidden");
    expect(await blocked.json()).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32601 } });
    const allowed = await f.proxy(session.id, "tools/call", "public", headers, mode === "legacy binding");
    expect((await allowed.json() as any).result.content[0].text).toBe("hello");
    expect(f.seen.map(r => r.method)).toEqual(["tools/list", "tools/call"]);
  });
});
