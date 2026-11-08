// @ts-nocheck
// Characterization of the Cloudflare sandbox proxy routes (/v1/oma/mcp-proxy,
// /v1/oma/inference-proxy) through the real test worker: authMiddleware, D1
// Session rows, Vault credentials and model cards. The Node counterpart is
// apps/main-node/test/sandbox-proxy-routes.test.ts; both drive the public HTTP
// surface only, so the same assertions hold before and after the routes moved
// into packages/http-routes.
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const KEY = { "x-api-key": "test-key", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" };
const MCP = "https://mcp.proxy-char.test";
const MODEL = "https://model.proxy-char.test";
const TOKEN = "https://auth.proxy-char.test/token";

type Seen = { url: string; method: string; headers: Headers; body: string };
let seen: Seen[] = [];
let upstream: (request: Request, body: string) => Response | Promise<Response> = () => new Response("unset", { status: 599 });

function call(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`https://localhost${path}`, init));
}
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await call(path, { method, headers: KEY, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}
/** CF's errorEnvelopeMiddleware wraps every 4xx/5xx JSON body (upstream ones too). */
const errorMessage = async (response: Response) => {
  const body = await response.json();
  return typeof body.error === "string" ? body.error : body.error?.message;
};
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

async function managedSession(document: Record<string, unknown>, archived = false) {
  const id = unique("char-managed");
  await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
    (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
    VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,?)`)
    .bind(id, JSON.stringify(document), Date.now(), Date.now(), archived ? Date.now() : null).run();
  return id;
}

async function legacySession(snapshot: Record<string, unknown>, vaultIds: string[] = [], archived = false) {
  await env.MAIN_DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, agent_id TEXT, environment_id TEXT,
    title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, vault_ids TEXT, agent_snapshot TEXT,
    environment_snapshot TEXT, metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER,
    archived_at INTEGER, turn_id TEXT, turn_started_at INTEGER, terminated_at INTEGER)`).run();
  const id = unique("char-legacy");
  await env.MAIN_DB.prepare(`INSERT INTO sessions
    (id, tenant_id, agent_id, environment_id, title, status, vault_ids, agent_snapshot, metadata, created_at, updated_at, archived_at)
    VALUES (?, 'default', 'agent_char', 'env_char', '', 'idle', ?, ?, '{}', ?, ?, ?)`)
    .bind(id, JSON.stringify(vaultIds), JSON.stringify({ name: "char", system: "s", ...snapshot }), Date.now(), Date.now(), archived ? Date.now() : null).run();
  return id;
}

const mcpServer = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "url", url: `${MCP}/${name}`, ...extra });
const rpc = (headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { ...KEY, authorization: "Bearer caller-secret", cookie: "openma=private", "x-oma-tenant": "spoofed", "mcp-session-id": "mcp-1", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

beforeAll(async () => {
  expect((await call("/health")).status).toBe(200);
});

afterEach(() => {
  vi.restoreAllMocks();
  seen = [];
});

function interceptUpstream() {
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (![MCP, MODEL, TOKEN.slice(0, TOKEN.lastIndexOf("/"))].some((origin) => request.url.startsWith(origin))) return original(input, init);
    const body = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
    seen.push({ url: request.url, method: request.method, headers: request.headers, body });
    if (request.url.startsWith(MODEL) && request.method === "GET") return Response.json({ data: [] });
    return upstream(request, body);
  });
}

describe("Cloudflare /v1/oma/mcp-proxy", () => {
  it("injects the Session's v1 Vault bearer, withholds caller credentials and returns the upstream response", async () => {
    interceptUpstream();
    const vault = await api("/v1/vaults", { display_name: "char" });
    await api(`/v1/vaults/${vault.id}/credentials`, { auth: { type: "static_bearer", mcp_server_url: `${MCP}/docs`, token: "vault-token" } });
    const id = await managedSession({ vaultIds: [vault.id], agent: { id: "agent", version: 1, mcpServers: [mcpServer("docs")] } });
    upstream = () => new Response("event: message\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "mcp-2" } });
    const response = await call(`/v1/oma/mcp-proxy/${id}/docs`, rpc());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("mcp-session-id")).toBe("mcp-2");
    expect(await response.text()).toBe("event: message\ndata: {}\n\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: `${MCP}/docs`, method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(seen[0].headers.get("authorization")).toBe("Bearer vault-token");
    expect(seen[0].headers.get("mcp-session-id")).toBe("mcp-1");
    for (const name of ["x-api-key", "cookie", "x-oma-tenant"]) expect(seen[0].headers.has(name), name).toBe(false);
  });

  it("passes the upstream status through unchanged", async () => {
    interceptUpstream();
    const id = await managedSession({ vaultIds: [], agent: { id: "agent", version: 1, mcpServers: [mcpServer("docs", { authorizationToken: "inline" })] } });
    upstream = () => new Response('{"error":"boom"}', { status: 502, headers: { "content-type": "application/json" } });
    const response = await call(`/v1/oma/mcp-proxy/${id}/docs`, rpc());
    expect(response.status).toBe(502);
    expect(await errorMessage(response)).toBe("boom");
    expect(seen[0].headers.get("authorization")).toBe("Bearer inline");
  });

  it("handles a Session with neither Vaults nor an inline token (managed and legacy)", async () => {
    interceptUpstream();
    upstream = () => new Response("anonymous-ok");
    const managed = await managedSession({ vaultIds: [], agent: { id: "agent", version: 1, mcpServers: [mcpServer("public")] } });
    const legacy = await legacySession({ mcp_servers: [mcpServer("public")] });
    for (const id of [managed, legacy]) {
      const response = await call(`/v1/oma/mcp-proxy/${id}/public`, rpc());
      expect(response.status, id).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  it("rejects unknown Sessions, undeclared servers and archived Sessions without contacting upstream", async () => {
    interceptUpstream();
    upstream = () => new Response("must-not-run");
    const live = await managedSession({ vaultIds: [], agent: { id: "agent", version: 1, mcpServers: [mcpServer("docs", { authorizationToken: "inline" })] } });
    const archived = await managedSession({ vaultIds: [], agent: { id: "agent", version: 1, mcpServers: [mcpServer("docs", { authorizationToken: "inline" })] } }, true);
    const archivedLegacy = await legacySession({ mcp_servers: [mcpServer("docs", { authorization_token: "inline" })] }, [], true);
    for (const path of [`missing-session/docs`, `${live}/undeclared`, `${archived}/docs`, `${archivedLegacy}/docs`]) {
      const response = await call(`/v1/oma/mcp-proxy/${path}`, rpc());
      expect(response.status, path).toBe(403);
      expect(await errorMessage(response)).toBe("forbidden");
    }
    expect(seen).toEqual([]);
  });

  it("requires a caller credential", async () => {
    interceptUpstream();
    const response = await call("/v1/oma/mcp-proxy/any/docs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("uses a legacy Session's inline authorization_token", async () => {
    interceptUpstream();
    upstream = () => new Response("inline-ok");
    const id = await legacySession({ mcp_servers: [mcpServer("docs", { authorization_token: "legacy-inline" })] });
    const response = await call(`/v1/oma/mcp-proxy/${id}/docs`, rpc());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("inline-ok");
    expect(seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer legacy-inline"]);
  });

  it("refreshes a legacy mcp_oauth credential once on 401, persists it and retries with the new token", async () => {
    interceptUpstream();
    const vault = await api("/v1/oma/vaults", { name: "char-legacy" });
    await api(`/v1/oma/vaults/${vault.id}/credentials`, { display_name: "oauth", auth: {
      type: "mcp_oauth", mcp_server_url: `${MCP}/oauth`, access_token: "old-access",
      refresh_token: "refresh-1", token_endpoint: TOKEN, client_id: "char-client",
    } });
    const id = await legacySession({ mcp_servers: [mcpServer("oauth")] }, [vault.id]);
    upstream = (request, body) => {
      if (request.url === TOKEN) {
        expect(new URLSearchParams(body).get("refresh_token")).toBe("refresh-1");
        return Response.json({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 });
      }
      return request.headers.get("authorization") === "Bearer new-access"
        ? new Response("refreshed-ok")
        : new Response('{"error":"expired"}', { status: 401 });
    };
    const first = await call(`/v1/oma/mcp-proxy/${id}/oauth`, rpc());
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("refreshed-ok");
    expect(seen.map((request) => request.url === TOKEN ? "token" : request.headers.get("authorization")))
      .toEqual(["Bearer old-access", "token", "Bearer new-access"]);
    seen = [];
    const second = await call(`/v1/oma/mcp-proxy/${id}/oauth`, rpc());
    expect(second.status).toBe(200);
    expect(seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer new-access"]);
  });
});

describe("Cloudflare /v1/oma/inference-proxy", () => {
  async function modelCard() {
    const handle = unique("char-model");
    await api("/v1/oma/model_cards", { model_id: handle, provider: "anthropic", model: "wire-model", api_key: "card-key", base_url: MODEL });
    return handle;
  }
  async function modelSession(archived = false) {
    return managedSession({ vaultIds: [], agent: { id: "agent", version: 1, model: await modelCard(), mcpServers: [] } }, archived);
  }
  const message = (headers: Record<string, string> = KEY) => ({
    method: "POST",
    headers: { ...headers, authorization: headers["x-api-key"] ? `Bearer ${headers["x-api-key"]}` : "", "x-oma-session": "spoofed" },
    body: JSON.stringify({ model: "workspace-handle", messages: [], stream: true }),
  });

  // Characterized as found: the CF route computes the sub-path against the
  // child route ("/<sid>/") while Hono's req.path is the full mounted path, so
  // every mounted call loses its endpoint and is refused before any upstream call.
  it("routes a mounted request path to the Session's model card", async () => {
    interceptUpstream();
    const id = await modelSession();
    seen = [];
    upstream = () => new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    const response = await call(`/v1/oma/inference-proxy/${id}/v1/messages?beta=true`, message());
    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toBe("inference_endpoint_unsupported");
    expect(seen).toEqual([]);
  });

  it("rejects a Session without an active model card, an archived Session and an unknown Session", async () => {
    interceptUpstream();
    const archived = await modelSession(true);
    const noCard = await managedSession({ vaultIds: [], agent: { id: "agent", version: 1, model: unique("no-card"), mcpServers: [] } });
    seen = [];
    for (const id of [archived, noCard, "missing-session"]) {
      const response = await call(`/v1/oma/inference-proxy/${id}/v1/messages`, message());
      expect(response.status, id).toBe(403);
      expect(await errorMessage(response)).toBe("forbidden");
    }
    expect(seen).toEqual([]);
  });

  it("handles an archived legacy Session", async () => {
    interceptUpstream();
    const id = await legacySession({ model: await modelCard() }, [], true);
    seen = [];
    upstream = () => Response.json({});
    const response = await call(`/v1/oma/inference-proxy/${id}/v1/messages`, message());
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("requires exactly one caller credential", async () => {
    interceptUpstream();
    const missing = await call("/v1/oma/inference-proxy/any/v1/messages", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    const conflicting = await call("/v1/oma/inference-proxy/any/v1/messages", { method: "POST", headers: { authorization: "Bearer a", "x-api-key": "b" }, body: "{}" });
    expect(conflicting.status).toBe(401);
    expect(seen).toEqual([]);
  });
});
