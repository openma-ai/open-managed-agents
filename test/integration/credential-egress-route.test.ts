// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.restoreAllMocks());
import { createEgressRelayPasses } from "../../packages/managed-credential-resolver/src/relay";
import { sqlClientFromD1 } from "../../packages/sql-client/src/adapters/cf-d1";
import { ensureRuntimeResourceFenceSchema, SqlRuntimeResourceFencePort } from "../../packages/runtime-resource-fence-sql/src/index";

describe("Cloudflare production Session relay route", () => {
  it("revokes resolve, forward and MCP injection after Vault archival or deletion", async () => {
    const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      const response = await exports.default.fetch(new Request(`https://localhost${path}`, {
        method, headers: { "x-api-key": "test-key", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      return response.json();
    };
    await exports.default.fetch(new Request("http://localhost/health"));
    const target = "https://vault-authority.example/mcp";
    const vault = await api("/v1/vaults", { display_name: "relay authority" });
    await api(`/v1/vaults/${vault.id}/credentials`, { auth: { type: "static_bearer", mcp_server_url: target, token: "upstream-vault-token" } });
    const id = `relay-vault-${crypto.randomUUID()}`;
    await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
      (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
      VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,NULL)`)
      .bind(id, JSON.stringify({ vaultIds: [vault.id], agent: { mcpServers: [{ name: "docs", type: "url", url: target }] } }), Date.now(), Date.now()).run();
    const passes = createEgressRelayPasses(env.PLATFORM_ROOT_SECRET, Date.now);
    const pass = await passes.issue({ workspaceId: "default", sessionId: id, ttlMs: 60000 });
    const upstreamTokens: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.url).toBe(target); upstreamTokens.push(request.headers.get("authorization"));
      return new Response("ok");
    });
    const relay = (action: string) => exports.default.fetch(new Request(`https://localhost/v1/oma/egress/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${pass}`, "x-oma-egress-target": target, "x-oma-egress-method": "GET" },
    }));
    const mcp = () => exports.default.fetch(new Request(`https://localhost/v1/oma/mcp-proxy/${id}/docs`, {
      method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: "{}",
    }));
    try {
      expect(await (await relay("resolve")).json()).toEqual({ inject: true });
      expect((await relay("forward")).status).toBe(200);
      expect(upstreamTokens).toEqual(["Bearer upstream-vault-token"]);
      const archived = await api(`/v1/vaults/${vault.id}/archive`, {});
      expect(archived.archived_at).not.toBeNull();
      const denied = async () => {
        expect(await (await relay("resolve")).json()).toEqual({ inject: false });
        expect((await relay("forward")).status).toBe(403);
        upstreamTokens.length = 0;
        expect((await mcp()).status).toBeGreaterThanOrEqual(400);
        expect(upstreamTokens).toEqual([]);
      };
      await denied();
      await api(`/v1/vaults/${vault.id}`, undefined, "DELETE");
      await denied();
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });
  it.each([
    { cliId: "glab", target: "https://gitlab.com/api/v4/user", alias: "PRIVATE-TOKEN" },
    { cliId: "gh", target: "https://api.github.com/user", alias: "X-Github-Token" },
  ])("strips $cliId placeholder aliases in the production CF relay", async ({ cliId, target, alias }) => {
    const api = async (path: string, body: unknown) => {
      const response = await exports.default.fetch(new Request(`https://localhost${path}`, { method: "POST", headers: {
        "x-api-key": "test-key", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01",
      }, body: JSON.stringify(body) }));
      expect(response.status, await response.clone().text()).toBeLessThan(300); return response.json();
    };
    await exports.default.fetch(new Request("http://localhost/health"));
    const vault = await api("/v1/vaults", { display_name: "CLI protocol" });
    await api(`/v1/vaults/${vault.id}/credentials`, { auth: { type: "cap_cli", cli_id: cliId, token: "real-cli-token" } });
    const id = `relay-cli-${crypto.randomUUID()}`;
    await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
      (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
      VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,NULL)`)
      .bind(id, JSON.stringify({ vaultIds: [vault.id] }), Date.now(), Date.now()).run();
    const seen: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.url).toBe(target); seen.push(request.headers); return new Response("ok");
    });
    const passes = createEgressRelayPasses(env.PLATFORM_ROOT_SECRET, Date.now);
    try {
      const response = await exports.default.fetch(new Request("https://localhost/v1/oma/egress/forward", { method: "POST", headers: {
        authorization: `Bearer ${await passes.issue({ workspaceId: "default", sessionId: id, ttlMs: 60000 })}`,
        "x-oma-egress-target": target, "x-oma-egress-method": "GET",
        "x-oma-egress-headers": JSON.stringify({ [alias]: "__cap_managed__", authorization: "Bearer __cap_managed__" }),
      } }));
      expect(response.status).toBe(200); expect(seen).toHaveLength(1);
      expect(seen[0].get("authorization")).toBe("Bearer real-cli-token"); expect(seen[0].has(alias)).toBe(false);
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });

  it("accepts only the Session pass, uses the current D1 Session and denies archival", async () => {
    const health = await exports.default.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    const id = `relay-${crypto.randomUUID()}`;
    await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
      (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
      VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,NULL)`)
      .bind(id, JSON.stringify({ vaultIds: [] }), Date.now(), Date.now()).run();
    const passes = createEgressRelayPasses(env.PLATFORM_ROOT_SECRET, Date.now);
    const pass = await passes.issue({ workspaceId: "default", sessionId: id, ttlMs: 60000 });
    const call = (authorization: string) => exports.default.fetch(new Request("https://localhost/v1/oma/egress/resolve", {
      method: "POST", headers: { authorization, "x-oma-egress-target": "https://public.example/" },
    }));
    try {
      const response = await call(`Bearer ${pass}`);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ inject: false });
      expect((await call("Bearer test-key")).status).toBe(401);
      await env.MAIN_DB.prepare("UPDATE managed_sessions SET archived_at=? WHERE workspace_id='default' AND id=?").bind(Date.now(), id).run();
      expect((await call(`Bearer ${pass}`)).status).toBe(403);
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });
});

describe("Cloudflare native credential egress RPC", () => {
  // createEgressRelayPasses imports exactly this HMAC key; the RPC must never mint one.
  const relayPassKeys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([format, data]) =>
    format === "raw" && new TextDecoder().decode(data as Uint8Array).startsWith("credential-relay.v1:")).length;

  it("serves resolve and forward without a relay pass, keeping fence and Session denials", async () => {
    const api = async (path: string, body: unknown) => {
      const response = await exports.default.fetch(new Request(`https://localhost${path}`, { method: "POST", headers: {
        "x-api-key": "test-key", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01",
      }, body: JSON.stringify(body) }));
      expect(response.status, await response.clone().text()).toBeLessThan(300); return response.json();
    };
    await exports.default.fetch(new Request("http://localhost/health"));
    const target = "https://rpc-authority.example/mcp";
    const vault = await api("/v1/vaults", { display_name: "rpc relay" });
    await api(`/v1/vaults/${vault.id}/credentials`, { auth: { type: "static_bearer", mcp_server_url: target, token: "rpc-vault-token" } });
    const id = `relay-rpc-${crypto.randomUUID()}`;
    await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
      (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
      VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,NULL)`)
      .bind(id, JSON.stringify({ vaultIds: [vault.id] }), Date.now(), Date.now()).run();
    const sql = sqlClientFromD1(env.MAIN_DB);
    await ensureRuntimeResourceFenceSchema(sql);
    const acquired = await new SqlRuntimeResourceFencePort(sql).acquire({
      scope: { workspaceId: "default", environmentId: "environment", sessionId: id, workId: "work" }, ownerId: "owner", ttlMs: 600000,
    });
    if (acquired.type !== "acquired") throw new Error("expected fence");
    const { environmentId, workId, ownerId, generation, token } = acquired.fence;
    const runtimeFence = { environmentId, workId, ownerId, generation, token };
    const upstream: Array<{ url: string; method: string; headers: Headers; body: Uint8Array }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(input);
      upstream.push({ url: request.url, method: request.method, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(new Uint8Array([1, 255]), { status: 201, headers: { connection: "x-hop", "x-hop": "strip", "x-upstream": "keep" } });
    });
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const egress = (action: "resolve" | "forward", request: Request, fence: unknown = runtimeFence) =>
      env.MAIN_MCP.credentialEgress({ tenantId: "default", sessionId: id, ...(fence === undefined ? {} : { runtimeFence: fence }) }, action, request);
    const post = (url = target) => new Request(url, { method: "POST", body: new Uint8Array([0, 255, 128]), headers: {
      authorization: "Bearer __cap_managed__", "proxy-authorization": "strip", "x-client": "keep",
    } });
    try {
      expect(await (await egress("resolve", new Request(target))).json()).toEqual({ inject: true });
      expect(await (await egress("resolve", new Request("https://public.example/"))).json()).toEqual({ inject: false });
      expect(await (await egress("resolve", new Request(target), undefined)).json()).toEqual({ inject: true });
      const forwarded = await egress("forward", post());
      expect(forwarded.status).toBe(201);
      expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(new Uint8Array([1, 255]));
      expect(forwarded.headers.get("x-upstream")).toBe("keep");
      for (const header of ["connection", "x-hop"]) expect(forwarded.headers.has(header)).toBe(false);
      expect(upstream).toHaveLength(1);
      expect(upstream[0]).toMatchObject({ url: target, method: "POST", body: new Uint8Array([0, 255, 128]) });
      expect(upstream[0]!.headers.get("authorization")).toBe("Bearer rpc-vault-token");
      expect(upstream[0]!.headers.get("x-client")).toBe("keep");
      expect(upstream[0]!.headers.has("proxy-authorization")).toBe(false);
      const get = await egress("forward", new Request(target));
      expect(get.status).toBe(201); expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([1, 255]));
      expect(upstream[1]).toMatchObject({ method: "GET", body: new Uint8Array([]) });
      upstream.length = 0;

      const denied = async (response: Response, status: number, text: string) => {
        expect(response.status).toBe(status); expect(await response.text()).toBe(text);
      };
      await denied(await egress("forward", post("https://public.example/")), 403, "Credential relay request denied");
      await denied(await egress("forward", post("http://rpc-authority.example/mcp")), 400, "Credential relay request denied");
      await denied(await egress("resolve", new Request(`${target}#fragment`)), 400, "Credential relay request denied");
      const stale = { ...runtimeFence, token: "stale-token" };
      await denied(await egress("resolve", new Request(target), stale), 403, "Credential relay denied");
      // Denied before buffering, so send no RPC body stream that nobody would drain.
      await denied(await egress("forward", new Request(target, { method: "POST" }), stale), 403, "Credential relay denied");
      await denied(await env.MAIN_MCP.credentialEgress({ tenantId: "default", sessionId: `${id}-missing` }, "resolve", new Request(target)), 403, "Credential relay request denied");
      await env.MAIN_DB.prepare("UPDATE managed_sessions SET archived_at=? WHERE workspace_id='default' AND id=?").bind(Date.now(), id).run();
      await denied(await egress("resolve", new Request(target)), 403, "Credential relay request denied");
      await denied(await egress("forward", post()), 403, "Credential relay request denied");
      expect(upstream).toEqual([]);
      expect(relayPassKeys(importKey)).toBe(0);
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });
});
