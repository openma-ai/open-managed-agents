import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpProxyBinding,
  createMcpProxyRoutes,
  forwardMcpProxyRequest,
} from "../../src/proxy/mcp-proxy-routes";
import type { McpProxyPorts } from "../../src/proxy/mcp-proxy-ports";

const SERVER = "https://mcp.example.test/rpc";
const WITHHELD = ["authorization", "x-api-key", "cookie", "proxy-authorization", "x-oma-session", "x-oma-tenant", "x-oma-mcp-server", "x-oma-agent-id", "x-oma-agent-version"];

function upstream(respond: (request: Request) => Response | Promise<Response> = () => new Response("upstream")) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(input instanceof Request ? input : new Request(input, init)));
}
function ports(input: {
  managed?: unknown;
  legacy?: unknown;
  grouped?: () => Promise<unknown>;
  managedCredentials?: unknown;
  fetch?: typeof fetch;
  accessLoss?: unknown;
}) {
  return {
    sessions: {
      managed: { find: vi.fn(async () => input.managed ?? null) },
      legacy: { get: vi.fn(async () => input.legacy ?? null) },
    },
    legacyCredentials: { listByVaults: vi.fn(input.grouped ?? (async () => [])) },
    managedCredentials: () => input.managedCredentials ?? (() => { throw new Error("no managed credentials"); })(),
    log: { info: vi.fn(), warn: vi.fn() },
    ...(input.fetch !== undefined && { fetch: input.fetch }),
    ...(input.accessLoss !== undefined && { accessLoss: input.accessLoss }),
  } as unknown as McpProxyPorts & { sessions: { legacy: { get: ReturnType<typeof vi.fn> } } };
}
const managedSession = (servers: unknown[], vaultIds: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ archivedAt: null, vaultIds, agent: { id: "root", version: 1, mcpServers: servers, ...extra } });
const legacySession = (servers: unknown[], vaultIds: string[] = []) =>
  ({ archived_at: null, vault_ids: vaultIds, agent_snapshot: { id: "root", version: 1, mcp_servers: servers } });
const server = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "url", url: SERVER, ...extra });
const staticBearer = (token: string) => async () => [{ vault_id: "vlt_1", credentials: [{ id: "c", auth: { type: "static_bearer", mcp_server_url: SERVER, bearer_token: token } }] }];
const routing = (sessionId: string, serverName: string) => ({ "x-oma-tenant": "tenant-1", "x-oma-session": sessionId, "x-oma-mcp-server": serverName });

describe("createMcpProxyBinding", () => {
  it.each([200, 401, 403])("forwards an anonymous target once and preserves status %s", async (status) => {
    const fetch = upstream((request) => {
      expect(request.url).toBe(SERVER);
      expect(request.headers.get("mcp-session-id")).toBe("upstream-session");
      for (const name of WITHHELD) expect(request.headers.has(name), name).toBe(false);
      return new Response("upstream", { status });
    });
    const binding = createMcpProxyBinding(() => ports({ managed: managedSession([server("public")]), fetch }));
    const response = await binding.fetch(new Request(SERVER, {
      method: "POST", body: "{}",
      headers: {
        ...routing("session", "public"), "mcp-session-id": "upstream-session", authorization: "Bearer caller-secret",
        "x-api-key": "caller-key", cookie: "session=private", "proxy-authorization": "Basic private",
      },
    }));
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("upstream");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("propagates a credential store failure without forwarding", async () => {
    const fetch = upstream();
    const binding = createMcpProxyBinding(() => ports({
      legacy: legacySession([server("linear")], ["vlt_1"]),
      grouped: async () => { throw new Error("credentials unavailable"); },
      fetch,
    }));
    await expect(binding.fetch(new Request(SERVER, { headers: routing("session", "linear") }))).rejects.toThrow("credentials unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("injects the Vault bearer for the workspace named by the routing headers and strips them", async () => {
    const fetch = upstream((request) => {
      expect(request.url).toBe(SERVER);
      expect(request.headers.get("authorization")).toBe("Bearer vault-token");
      expect(request.headers.get("mcp-session-id")).toBe("upstream-session");
      for (const name of WITHHELD.slice(4)) expect(request.headers.has(name), name).toBe(false);
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" } });
    });
    const p = ports({ legacy: legacySession([server("linear")], ["vlt_1"]), grouped: staticBearer("vault-token"), fetch });
    const portsFor = vi.fn(() => p);
    const response = await createMcpProxyBinding(portsFor).fetch(new Request(SERVER, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "upstream-session", ...routing("session-1", "linear") },
      body: '{"jsonrpc":"2.0","id":1}',
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("upstream-session");
    expect(portsFor).toHaveBeenCalledWith("tenant-1");
    expect(p.sessions.legacy.get).toHaveBeenCalledWith({ tenantId: "tenant-1", sessionId: "session-1" });
  });

  it("routes a pinned roster member's request to its own same-name server", async () => {
    const fetch = upstream((request) => {
      expect(request.url).toBe("https://child.test/mcp");
      expect(request.headers.get("authorization")).toBe("Bearer child-token");
      expect(request.headers.has("x-oma-agent-id")).toBe(false);
      expect(request.headers.has("x-oma-agent-version")).toBe(false);
      return new Response("child-result");
    });
    const binding = createMcpProxyBinding(() => ports({
      managed: managedSession([server("same-name", { authorizationToken: "root-token" })], [], {
        multiagent: { subagents: { type: "enabled", predefinedAgents: [{ type: "agent", id: "child", version: 7,
          mcpServers: [server("same-name", { url: "https://child.test/mcp", authorizationToken: "child-token" })] }] } },
      }),
      fetch,
    }));
    const response = await binding.fetch(new Request(SERVER, { headers: {
      ...routing("session", "same-name"), "x-oma-agent-id": "child", "x-oma-agent-version": "7",
    } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("child-result");
  });

  it.each([
    ["no routing headers", {}],
    ["no server", { "x-oma-tenant": "tenant-1", "x-oma-session": "session" }],
    ["an agent id without a version", { ...routing("session", "docs"), "x-oma-agent-id": "child" }],
    ["a non-positive agent version", { ...routing("session", "docs"), "x-oma-agent-id": "child", "x-oma-agent-version": "0" }],
    ["a non-numeric agent version", { ...routing("session", "docs"), "x-oma-agent-id": "child", "x-oma-agent-version": "7a" }],
  ])("fails closed with %s", async (_case, headers) => {
    const fetch = upstream();
    const portsFor = vi.fn(() => ports({ managed: managedSession([server("docs")]), fetch }));
    const response = await createMcpProxyBinding(portsFor).fetch(new Request(SERVER, { method: "POST", body: "{}", headers }));
    expect(response.status).toBe(403);
    expect(portsFor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createMcpProxyRoutes", () => {
  function mounted(portsFor: Parameters<typeof createMcpProxyRoutes>[0], tenant: string | null = "tenant-1") {
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => {
      if (tenant !== null) c.set("tenant_id", tenant);
      await next();
    });
    app.route("/v1/oma/mcp-proxy", createMcpProxyRoutes(portsFor));
    return app;
  }

  it("uses the authenticated tenant and replaces the caller's bearer upstream", async () => {
    const fetch = upstream(async (request) => {
      expect(request.url).toBe(SERVER);
      expect(request.headers.get("authorization")).toBe("Bearer vault-token");
      expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
      return new Response("upstream", { status: 202 });
    });
    const p = ports({ legacy: legacySession([server("linear")], ["vlt_1"]), grouped: staticBearer("vault-token"), fetch });
    const portsFor = vi.fn(() => p);
    const response = await mounted(portsFor).request("/v1/oma/mcp-proxy/session-1/linear", {
      method: "POST",
      headers: { authorization: "Bearer work-sessions-token", "content-type": "application/json", "x-oma-tenant": "forged" },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(response.status).toBe(202);
    expect(portsFor).toHaveBeenCalledWith("tenant-1", expect.anything());
    expect(p.sessions.legacy.get).toHaveBeenCalledWith({ tenantId: "tenant-1", sessionId: "session-1" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails closed when the Session/server pair does not resolve", async () => {
    const fetch = upstream();
    const response = await mounted(() => ports({ fetch })).request("/v1/oma/mcp-proxy/other-session/linear", {
      method: "POST", headers: { authorization: "Bearer work-sessions-token" }, body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a request no middleware authenticated", async () => {
    const portsFor = vi.fn(() => ports({}));
    const response = await mounted(portsFor, null).request("/v1/oma/mcp-proxy/session-1/linear", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(portsFor).not.toHaveBeenCalled();
  });
});

describe("forwardMcpProxyRequest", () => {
  const request = (headers: Record<string, string> = {}, body: () => Promise<string | null> = async () => '{"jsonrpc":"2.0","method":"tools/list","id":1}') => ({
    workspaceId: "workspace_01", sessionId: "session_01", serverName: "linear",
    method: "POST", headers: new Headers({ "content-type": "application/json", ...headers }), body, callerKind: "http" as const,
  });

  it("resolves a v1 managed Session through the managed credentials, never the legacy stores", async () => {
    const fetch = upstream((upstreamRequest) => {
      expect(upstreamRequest.headers.get("authorization")).toBe("Bearer managed-vault-token");
      return new Response("proxied-v1");
    });
    const selected = { upstreamUrl: SERVER, upstreamToken: "managed-vault-token" };
    const managedCredentials = {
      mcpTarget: vi.fn(async () => selected),
      forward: vi.fn(async (_workspaceId: string, target: typeof selected, send: (token: string) => Promise<Response>) =>
        ({ response: await send(target.upstreamToken), refreshed: false, refreshFailed: false, refreshFailureCode: null })),
    };
    const p = ports({ managed: managedSession([server("linear")], ["vault_01"]), managedCredentials, fetch });
    p.sessions.legacy.get.mockRejectedValue(new Error("the v1 proxy must not read the legacy sessions store"));
    (p.legacyCredentials.listByVaults as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("must not read legacy credentials"));
    const response = await forwardMcpProxyRequest(p, request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied-v1");
    expect(managedCredentials.mcpTarget).toHaveBeenCalledWith({ workspaceId: "workspace_01", sessionId: "session_01", vaultIds: ["vault_01"] }, SERVER);
    expect(managedCredentials.forward).toHaveBeenCalledWith("workspace_01", selected, expect.any(Function));
    expect(p.sessions.legacy.get).not.toHaveBeenCalled();
    expect(p.legacyCredentials.listByVaults).not.toHaveBeenCalled();
  });

  it("injects a legacy Session's inline token and never forwards the caller's credentials", async () => {
    const fetch = upstream((upstreamRequest) => {
      expect(upstreamRequest.headers.get("authorization")).toBe("Bearer upstream-vault-token");
      expect(upstreamRequest.headers.has("x-api-key")).toBe(false);
      expect(upstreamRequest.headers.has("cookie")).toBe(false);
      expect(upstreamRequest.redirect).toBe("manual");
      return new Response("proxied");
    });
    const p = ports({ legacy: legacySession([server("linear", { authorization_token: "upstream-vault-token" })]), fetch });
    const response = await forwardMcpProxyRequest(p, request({
      authorization: "Bearer sk-ant-req-v1.current-work-claim", "x-api-key": "openma-control-key", cookie: "openma-session=must-not-leak",
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies the final response for access loss with the request body and the generation captured before sending", async () => {
    const accessLoss = { prepare: vi.fn(), captureGeneration: vi.fn(async () => 3), observe: vi.fn(async () => ({ type: "retryable" })) };
    const fetch = upstream(() => new Response('{"error":"revoked"}', { status: 403 }));
    const p = ports({ legacy: legacySession([server("linear", { authorization_token: "token" })]), fetch, accessLoss });
    const response = await forwardMcpProxyRequest(p, request({}, async () => '{"jsonrpc":"2.0","method":"tools/call","id":2}'));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('{"error":"revoked"}');
    expect(accessLoss.captureGeneration).toHaveBeenCalledWith({ workspaceId: "workspace_01", sessionId: "session_01" });
    expect(accessLoss.observe).toHaveBeenCalledWith({
      workspaceId: "workspace_01", sessionId: "session_01", serverName: "linear", generation: 3,
      requestBody: '{"jsonrpc":"2.0","method":"tools/call","id":2}',
      result: { status: 403, bodyText: '{"error":"revoked"}', refreshed: false, refreshFailed: false, refreshFailureCode: null },
    });
  });

  it("does not read the body of a refused request", async () => {
    const body = vi.fn(async () => "{}");
    const response = await forwardMcpProxyRequest(ports({}), request({}, body));
    expect(response.status).toBe(403);
    expect(body).not.toHaveBeenCalled();
  });
});


describe("MCP tool selection (#568)", () => {
  const tools = [{ type: "mcp_toolset", mcp_server_name: "public", default_config: { enabled: false },
    configs: [{ name: "echo", enabled: true, permission_policy: { type: "always_ask" } }] }];
  const rpc = (method: string, id = 1, name = "echo") => ({ jsonrpc: "2.0", id, method, params: { name } });
  function binding(fetch: typeof globalThis.fetch, configured = tools, legacy = false) {
    return createMcpProxyBinding(() => ports({ fetch,
      ...(legacy ? { legacy: { ...legacySession([server("public")]), agent_snapshot: {
        ...legacySession([server("public")]).agent_snapshot, tools: configured,
      } } } : { managed: managedSession([server("public")], [], { tools: configured.map(t => ({
        type: t.type, mcpServerName: t.mcp_server_name, defaultConfig: t.default_config, configs: t.configs,
      })) }) }),
    }));
  }
  const send = (b: ReturnType<typeof createMcpProxyBinding>, body: unknown) => b.fetch(new Request(SERVER, {
    method: "POST", headers: routing("session", "public"), body: JSON.stringify(body),
  }));

  it.each([false, true])("filters JSON lists and preserves pagination (legacy=%s)", async legacy => {
    const fetch = upstream(() => Response.json({ jsonrpc: "2.0", id: 1,
      result: { tools: [{ name: "hidden" }, { name: "echo" }], nextCursor: "page-2" } }));
    const response = await send(binding(fetch, tools, legacy), rpc("tools/list"));
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1,
      result: { tools: [{ name: "echo" }], nextCursor: "page-2" } });
  });
  it("filters SSE list responses", async () => {
    const fetch = upstream(() => new Response(`event: message
data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"hidden"},{"name":"echo"}],"nextCursor":"next"}}

`,
      { headers: { "content-type": "text/event-stream" } }));
    const response = await send(binding(fetch), rpc("tools/list"));
    const text = await response.text();
    expect(text).not.toContain("hidden");
    expect(text).toContain('"name":"echo"');
    expect(text).toContain('"nextCursor":"next"');
  });
  it("rejects disabled calls before sending anything upstream", async () => {
    const fetch = upstream();
    const response = await send(binding(fetch), rpc("tools/call", 7, "hidden"));
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32601 } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("forwards enabled calls without interpreting the response", async () => {
    const fetch = upstream(() => new Response("enabled"));
    expect(await (await send(binding(fetch), rpc("tools/call"))).text()).toBe("enabled");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("passes through without a matching toolset", async () => {
    const fetch = upstream(() => new Response("unchanged"));
    expect(await (await send(binding(fetch, []), rpc("tools/list"))).text()).toBe("unchanged");
  });
  it("removes disabled calls from a mixed batch and filters only list responses", async () => {
    const fetch = upstream(async request => {
      const body = await request.json() as any[];
      expect(body.map(r => r.id)).toEqual([1, 3]);
      return Response.json([{ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "hidden" }, { name: "echo" }] } },
        { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } }]);
    });
    const response = await send(binding(fetch), [rpc("tools/list"), rpc("tools/call", 2, "hidden"), rpc("tools/call", 3)]);
    const result = await response.json() as any[];
    expect(result).toHaveLength(3);
    expect(result.find(r => r.id === 1).result.tools).toEqual([{ name: "echo" }]);
    expect(result.find(r => r.id === 2).error.code).toBe(-32601);
    expect(result.find(r => r.id === 3).result.content[0].text).toBe("ok");
  });
  it("refuses an unresolved agent snapshot", async () => {
    const fetch = upstream();
    const b = createMcpProxyBinding(() => ports({ managed: { archivedAt: null, vaultIds: [] }, fetch }));
    expect((await send(b, rpc("tools/list"))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("MCP filtered stream lifecycle", () => {
  const configured = { tools: [{ type: "mcp_toolset", mcpServerName: "public", defaultConfig: { enabled: false }, configs: [{ name: "echo", enabled: true }] }] };
  it("forwards non-tool streams without waiting for EOF", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("live")); }, cancel });
    const b = createMcpProxyBinding(() => ports({ managed: managedSession([server("public")], [], configured),
      fetch: upstream(() => new Response(stream, { headers: { "content-type": "text/event-stream" } })) }));
    const response = await b.fetch(new Request(SERVER, { method: "POST", headers: routing("session", "public"), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }) }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("live");
    await reader.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("filters split SSE events before EOF and propagates cancellation", async () => {
    let canceled!: () => void;
    const cancellation = new Promise<void>(resolve => { canceled = resolve; });
    const stream = new ReadableStream({ start(c) {
      for (const text of ['id: 4\r\nevent: message\r\ndata: {"jsonrpc":"2.0",', '"id":1,"result":{"tools":[{"name":"hidden"},{"name":"echo"}]}}\r\n\r\n']) c.enqueue(new TextEncoder().encode(text));
    }, cancel() { canceled(); } });
    const b = createMcpProxyBinding(() => ports({ managed: managedSession([server("public")], [], configured),
      fetch: upstream(() => new Response(stream, { headers: { "content-type": "text/event-stream" } })) }));
    const response = await b.fetch(new Request(SERVER, { method: "POST", headers: routing("session", "public"), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    const reader = response.body!.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    expect(text).not.toContain("hidden");
    expect(text).toContain('"name":"echo"');
    expect(text).toContain("id: 4");
    await reader.cancel();
    await cancellation;
  });
});


it("returns a disabled batch call's error when the forwarded notification has no response", async () => {
  const fetch = upstream(() => new Response(null, { status: 202 }));
  const b = createMcpProxyBinding(() => ports({ fetch, managed: managedSession([server("public")], [], {
    tools: [{ type: "mcp_toolset", mcpServerName: "public", defaultConfig: { enabled: false } }],
  }) }));
  const response = await b.fetch(new Request(SERVER, { method: "POST", headers: routing("session", "public"), body: JSON.stringify([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hidden" } },
  ]) }));
  expect(await response.json()).toEqual([{ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "MCP tool is not enabled: hidden" } }]);
});
