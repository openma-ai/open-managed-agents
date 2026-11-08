// Characterization of the Node sandbox proxy routes (/v1/oma/mcp-proxy,
// /v1/oma/inference-proxy) through the real control plane: auth middleware,
// SQLite Session rows, Vault credentials and model cards. The Cloudflare
// counterpart is test/integration/sandbox-proxy-routes.test.ts; both drive the
// public HTTP surface only, so the same assertions hold before and after the
// routes moved into packages/http-routes.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";

const KEY = { "x-api-key": "test-admin", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" };

type Seen = { path: string; method: string; headers: IncomingHttpHeaders; body: string };
let seen: Seen[] = [];
let upstream: (request: Seen, response: ServerResponse) => void = (_request, response) => { response.writeHead(599); response.end(); };
let origin = "";
let cp: NodeControlPlane;
let environmentId = "";
let handle = "";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const entry = { path: request.url ?? "/", method: request.method ?? "GET", headers: request.headers, body };
  // The model card probe on create is not part of the proxy contract.
  if (entry.path.startsWith("/model") && entry.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end('{"data":[]}');
  }
  seen.push(entry);
  upstream(entry, response);
});
const dirs: string[] = [];

function call(path: string, init?: RequestInit) {
  return cp.fetch(new Request(`http://cp${path}`, init));
}
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await call(path, { method, headers: KEY, ...(body === undefined || method === "DELETE" ? {} : { body: JSON.stringify(body) }) });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.status === 204 ? null : response.json() as Promise<any>;
}
const errorMessage = async (response: Response) => {
  const body = await response.json() as any;
  return typeof body.error === "string" ? body.error : body.error?.message;
};
const reply = (status: number, body: string, headers: Record<string, string> = {}) =>
  (_request: Seen, response: ServerResponse) => { response.writeHead(status, headers); response.end(body); };
const mcpServer = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "url", url: `${origin}/mcp/${name}`, ...extra });

async function managedSession(servers: Array<Record<string, unknown>>, vaultIds: string[] = []) {
  const agent = await api("/v1/agents", {
    name: "char", model: handle, system: "s", mcp_servers: servers,
    tools: servers.map((server) => ({ type: "mcp_toolset", mcp_server_name: server.name })),
  });
  const session = await api("/v1/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: environmentId, vault_ids: vaultIds });
  return session.id as string;
}
/** The legacy Agent API refuses an inline `authorization_token`; Sessions that
 * carry one (older rows, integrations) are written to the snapshot directly. */
async function legacySession(servers: Array<Record<string, unknown>>, vaultIds: string[] = []) {
  const agent = await api("/v1/oma/agents", {
    name: "char", model: handle, system: "s",
    mcp_servers: servers.map(({ authorization_token: _inline, ...server }) => server),
    tools: servers.map((server) => ({ type: "mcp_toolset", mcp_server_name: server.name })),
  });
  const session = await api("/v1/oma/sessions", { agent: agent.id, environment_id: environmentId, vault_ids: vaultIds });
  if (servers.some((server) => server.authorization_token !== undefined)) {
    const sql = cp.components.database.sql;
    const row = await sql.prepare("SELECT agent_snapshot FROM sessions WHERE id = ?").bind(session.id).first<{ agent_snapshot: string }>();
    const snapshot = JSON.parse(row!.agent_snapshot);
    await sql.prepare("UPDATE sessions SET agent_snapshot = ? WHERE id = ?")
      .bind(JSON.stringify({ ...snapshot, mcp_servers: servers }), session.id).run();
  }
  return session.id as string;
}
const archiveLegacy = (id: string) =>
  cp.components.database.sql.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").bind(Date.now(), id).run();

const rpc = (headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { ...KEY, authorization: "Bearer test-admin", cookie: "openma=private", "x-oma-tenant": "spoofed", "mcp-session-id": "mcp-1", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await mkdtemp(join(tmpdir(), "oma-proxy-char-"));
  dirs.push(root);
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
  environmentId = (await api("/v1/environments", { name: "char", config: { type: "cloud", networking: { type: "unrestricted" } } })).id;
  handle = "char-model";
  await api("/v1/oma/model_cards", { model_id: handle, provider: "anthropic", model: "wire-model", api_key: "card-key", base_url: `${origin}/model` });
}, 60_000);

afterAll(async () => {
  await cp?.stop("test");
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
});

describe("Node /v1/oma/mcp-proxy", () => {
  it("injects the Session's v1 Vault bearer, withholds caller credentials and returns the upstream response", async () => {
    const vault = await api("/v1/vaults", { display_name: "char" });
    await api(`/v1/vaults/${vault.id}/credentials`, { auth: { type: "static_bearer", mcp_server_url: `${origin}/mcp/docs`, token: "vault-token" } });
    const id = await managedSession([mcpServer("docs")], [vault.id]);
    upstream = reply(200, "event: message\ndata: {}\n\n", { "content-type": "text/event-stream", "mcp-session-id": "mcp-2" });
    const response = await call(`/v1/oma/mcp-proxy/${id}/docs`, rpc());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("mcp-session-id")).toBe("mcp-2");
    expect(await response.text()).toBe("event: message\ndata: {}\n\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ path: "/mcp/docs", method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(seen[0]!.headers.authorization).toBe("Bearer vault-token");
    expect(seen[0]!.headers["mcp-session-id"]).toBe("mcp-1");
    for (const name of ["x-api-key", "cookie", "x-oma-tenant"]) expect(seen[0]!.headers[name], name).toBeUndefined();
  });

  it("passes the upstream status through unchanged", async () => {
    const id = await legacySession([mcpServer("docs", { authorization_token: "inline" })]);
    upstream = reply(502, '{"error":"boom"}', { "content-type": "application/json" });
    const response = await call(`/v1/oma/mcp-proxy/${id}/docs`, rpc());
    expect(response.status).toBe(502);
    expect(await errorMessage(response)).toBe("boom");
    expect(seen[0]!.headers.authorization).toBe("Bearer inline");
  });

  it("handles a Session with neither Vaults nor an inline token (managed and legacy)", async () => {
    upstream = reply(200, "anonymous-ok");
    const managed = await managedSession([mcpServer("public")]);
    const legacy = await legacySession([mcpServer("public")]);
    for (const id of [managed, legacy]) {
      const response = await call(`/v1/oma/mcp-proxy/${id}/public`, rpc());
      expect(response.status, id).toBe(200);
      expect(await response.text()).toBe("anonymous-ok");
    }
    expect(seen.map((request) => request.headers.authorization)).toEqual([undefined, undefined]);
  });

  it("rejects unknown Sessions, undeclared servers and archived Sessions without contacting upstream", async () => {
    upstream = reply(200, "must-not-run");
    const live = await managedSession([mcpServer("docs")]);
    const archived = await managedSession([mcpServer("docs")]);
    await api(`/v1/sessions/${archived}/archive`, {});
    const archivedLegacy = await legacySession([mcpServer("docs", { authorization_token: "inline" })]);
    await archiveLegacy(archivedLegacy);
    for (const path of [`missing-session/docs`, `${live}/undeclared`, `${archived}/docs`, `${archivedLegacy}/docs`]) {
      const response = await call(`/v1/oma/mcp-proxy/${path}`, rpc());
      expect(response.status, path).toBe(403);
      expect(await errorMessage(response)).toBe("forbidden");
    }
    expect(seen).toEqual([]);
  });

  it("requires a caller credential", async () => {
    const response = await call("/v1/oma/mcp-proxy/any/docs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("uses a legacy Session's inline authorization_token", async () => {
    upstream = reply(200, "inline-ok");
    const id = await legacySession([mcpServer("docs", { authorization_token: "legacy-inline" })]);
    const response = await call(`/v1/oma/mcp-proxy/${id}/docs`, rpc());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("inline-ok");
    expect(seen.map((request) => request.headers.authorization)).toEqual(["Bearer legacy-inline"]);
  });

  it("refreshes a legacy mcp_oauth credential once on 401, persists it and retries with the new token", async () => {
    const vault = await api("/v1/oma/vaults", { name: "char-legacy" });
    await api(`/v1/oma/vaults/${vault.id}/credentials`, { display_name: "oauth", auth: {
      type: "mcp_oauth", mcp_server_url: `${origin}/mcp/oauth`, access_token: "old-access",
      refresh_token: "refresh-1", token_endpoint: `${origin}/token`, client_id: "char-client",
    } });
    const id = await legacySession([mcpServer("oauth")], [vault.id]);
    upstream = (request, response) => {
      if (request.path === "/token") {
        expect(new URLSearchParams(request.body).get("refresh_token")).toBe("refresh-1");
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 }));
      }
      if (request.headers.authorization === "Bearer new-access") return reply(200, "refreshed-ok")(request, response);
      return reply(401, '{"error":"expired"}')(request, response);
    };
    const first = await call(`/v1/oma/mcp-proxy/${id}/oauth`, rpc());
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("refreshed-ok");
    expect(seen.map((request) => request.path === "/token" ? "token" : request.headers.authorization))
      .toEqual(["Bearer old-access", "token", "Bearer new-access"]);
    seen = [];
    const second = await call(`/v1/oma/mcp-proxy/${id}/oauth`, rpc());
    expect(second.status).toBe(200);
    expect(seen.map((request) => request.headers.authorization)).toEqual(["Bearer new-access"]);
  });
});

describe("Node /v1/oma/inference-proxy", () => {
  const message = (headers: Record<string, string> = KEY) => ({
    method: "POST",
    headers: { ...headers, authorization: headers["x-api-key"] ? `Bearer ${headers["x-api-key"]}` : "", "x-oma-session": "spoofed" },
    body: JSON.stringify({ model: "workspace-handle", messages: [], stream: true }),
  });

  it("routes a mounted request path to the Session's model card", async () => {
    const id = await managedSession([]);
    upstream = reply(200, "event: message_stop\ndata: {}\n\n", { "content-type": "text/event-stream" });
    const response = await call(`/v1/oma/inference-proxy/${id}/v1/messages?beta=true`, message());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("event: message_stop\ndata: {}\n\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ path: "/model/v1/messages?beta=true", method: "POST" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ model: "wire-model", messages: [], stream: true });
    expect(seen[0]!.headers["x-api-key"]).toBe("card-key");
    for (const name of ["authorization", "x-oma-session", "cookie"]) expect(seen[0]!.headers[name], name).toBeUndefined();
  });

  it("rejects an archived Session and an unknown Session", async () => {
    const archived = await managedSession([]);
    await api(`/v1/sessions/${archived}/archive`, {});
    for (const id of [archived, "missing-session"]) {
      const response = await call(`/v1/oma/inference-proxy/${id}/v1/messages`, message());
      expect(response.status, id).toBe(403);
      expect(await errorMessage(response)).toBe("forbidden");
    }
    expect(seen).toEqual([]);
  });

  it("handles an archived legacy Session", async () => {
    upstream = reply(200, "{}", { "content-type": "application/json" });
    const id = await legacySession([]);
    await archiveLegacy(id);
    const response = await call(`/v1/oma/inference-proxy/${id}/v1/messages`, message());
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("requires exactly one caller credential", async () => {
    const missing = await call("/v1/oma/inference-proxy/any/v1/messages", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    const conflicting = await call("/v1/oma/inference-proxy/any/v1/messages", { method: "POST", headers: { authorization: "Bearer a", "x-api-key": "b" }, body: "{}" });
    expect(conflicting.status).toBe(401);
    expect(seen).toEqual([]);
  });
});
