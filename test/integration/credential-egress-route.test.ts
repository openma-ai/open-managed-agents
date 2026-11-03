// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.restoreAllMocks());
import { createEgressRelayPasses } from "../../packages/managed-credential-resolver/src/relay";

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
