// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.restoreAllMocks());
import { sandboxBasicCredential, sandboxTokenSha256 } from "../../packages/sandbox-gateway/src/index";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
/** A pre-#561 HMAC relay pass, signed the way the removed issuer did: refused (design §0.0b B.4). */
async function legacyPass(claims: Record<string, unknown>) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`credential-relay.v2:${env.PLATFORM_ROOT_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
}

/** A running execution attempt for `sessionId`: the Session sandbox token
 * (relay and native egress) is bound to it (design §0.0 rule 10). */
async function runningAttempt(sessionId: string) {
  const executionId = `exe-${crypto.randomUUID()}`; const now = Date.now();
  await env.MAIN_DB.prepare(`INSERT INTO managed_session_executions
    (workspace_id, session_id, lane_id, id, admitted_at_ms, events_json, events_fingerprint, state, attempt_id, owner_id, generation,
     attempt_count, max_attempts, deadline_at_ms, claimed_at_ms, lease_expires_at_ms, revision)
    VALUES ('default', ?, 'sthr_primary', ?, ?, '[]', ?, 'running', 'att', 'owner', 1, 1, 3, ?, ?, ?, 1)`)
    .bind(sessionId, executionId, now, executionId, now + 600000, now, now + 600000).run();
  const fence = { executionId, attemptId: "att", ownerId: "owner", generation: 1 };
  return {
    fence,
    /** Issued through the main worker RPC the E2B SessionDO uses; `harness` fixes the scope. */
    token: (harness: string | null = null) => env.MAIN_MCP.issueSandboxToken({ tenantId: "default", sessionId, attempt: { workspaceId: "default", sessionId, ...fence }, harness }),
    settle: () => env.MAIN_DB.prepare("UPDATE managed_session_executions SET state='completed' WHERE workspace_id='default' AND id=?").bind(executionId).run(),
  };
}

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
    const attempt = await runningAttempt(id);
    const authorization = sandboxBasicCredential(id, await attempt.token());
    const upstreamTokens: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.url).toBe(target); upstreamTokens.push(request.headers.get("authorization"));
      return new Response("ok");
    });
    const relay = (action: string) => exports.default.fetch(new Request(`https://localhost/v1/oma/egress/${action}`, {
      method: "POST", headers: { authorization, "x-oma-egress-target": target, "x-oma-egress-method": "GET" },
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
    try {
      const response = await exports.default.fetch(new Request("https://localhost/v1/oma/egress/forward", { method: "POST", headers: {
        authorization: sandboxBasicCredential(id, await (await runningAttempt(id)).token()),
        "x-oma-egress-target": target, "x-oma-egress-method": "GET",
        "x-oma-egress-headers": JSON.stringify({ [alias]: "__cap_managed__", authorization: "Bearer __cap_managed__" }),
      } }));
      expect(response.status).toBe(200); expect(seen).toHaveLength(1);
      expect(seen[0].get("authorization")).toBe("Bearer real-cli-token"); expect(seen[0].has(alias)).toBe(false);
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });

  it("accepts only a sandbox token of the current execution attempt, uses the current D1 Session and refuses archival (design §0.0 rule 10, #561)", async () => {
    const health = await exports.default.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    const id = `relay-${crypto.randomUUID()}`;
    await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
      (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
      VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,NULL)`)
      .bind(id, JSON.stringify({ vaultIds: [] }), Date.now(), Date.now()).run();
    const attempt = await runningAttempt(id);
    const token = await attempt.token();
    const valid = sandboxBasicCredential(id, token);
    const legacy = await legacyPass({ workspaceId: "default", sessionId: id, ...attempt.fence, expiresAt: Date.now() + 60_000 });
    const staleLegacy = await legacyPass({ workspaceId: "default", sessionId: id, ...attempt.fence, attemptId: "previous", expiresAt: Date.now() + 60_000 });
    const call = (authorization: string) => exports.default.fetch(new Request("https://localhost/v1/oma/egress/resolve", {
      method: "POST", headers: { authorization, "x-oma-egress-target": "https://public.example/" },
    }));
    try {
      const response = await call(valid);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ inject: false });
      expect((await call("Bearer test-key")).status).toBe(401);
      expect((await call("Bearer unfenced")).status).toBe(401);
      expect((await call(`Bearer ${token}`)).status).toBe(401); // token without its Session id
      expect((await call(sandboxBasicCredential(`${id}-other`, token))).status).toBe(401);
      // No compatibility: a pre-#561 relay pass is refused even for the running attempt (design §0.0b B.4).
      expect((await call(`Bearer ${legacy}`)).status).toBe(401);
      expect((await call(`Bearer ${staleLegacy}`)).status).toBe(401);
      await env.MAIN_DB.prepare("UPDATE managed_sessions SET archived_at=? WHERE workspace_id='default' AND id=?").bind(Date.now(), id).run();
      expect((await call(valid)).status).toBe(401);
      await env.MAIN_DB.prepare("UPDATE managed_sessions SET archived_at=NULL WHERE workspace_id='default' AND id=?").bind(id).run();
      expect((await call(valid)).status).toBe(200);
      await attempt.settle(); // the turn ended: the token dies with its attempt
      expect((await call(valid)).status).toBe(401);
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });

  it("scope: a forwarder token of an outside harness passes egress and is refused (401) on the model gateway, MCP gateway and sandbox API; an acp-sandbox one passes", async () => {
    await exports.default.fetch(new Request("http://localhost/health"));
    const seed = async (name: string) => {
      const id = `scope-${name}-${crypto.randomUUID()}`;
      await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
        (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
        VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,NULL)`)
        .bind(id, JSON.stringify({ vaultIds: [], resources: [{ type: "file", fileId: "file_scope" }], agent: { id: "agent", version: 1, skills: [] } }), Date.now(), Date.now()).run();
      return { id, attempt: await runningAttempt(id) };
    };
    const outside = await seed("egress"); const inside = await seed("all");
    const egressToken = await outside.attempt.token(null);
    const allToken = await inside.attempt.token("acp-sandbox");
    // A re-sign keeps the attempt's scope (caught here: workerd reports a rejected RPC promise as unhandled otherwise).
    const mismatch = await outside.attempt.token("acp-sandbox").then(() => null, (error: Error) => error.message);
    expect(mismatch).toMatch(/scope/);
    const resolve = (id: string, token: string) => exports.default.fetch(new Request("https://localhost/v1/oma/egress/resolve", {
      method: "POST", headers: { authorization: sandboxBasicCredential(id, token), "x-oma-egress-target": "https://public.example/" },
    }));
    const api = (path: string, authorization: string) => exports.default.fetch(new Request(`https://localhost${path}`, {
      method: path.startsWith("/v1/files") ? "GET" : "POST", headers: { authorization, "content-type": "application/json" }, ...(path.startsWith("/v1/files") ? {} : { body: "{}" }),
    }));
    try {
      expect((await resolve(outside.id, egressToken)).status).toBe(200);
      expect((await resolve(inside.id, allToken)).status).toBe(200);
      for (const [id, token, expected] of [[outside.id, egressToken, 401], [inside.id, allToken, "not401"]] as const) {
        for (const response of [
          await api(`/v1/oma/inference-proxy/${id}/anthropic/v1/messages`, `Bearer ${token}`),
          await api(`/v1/oma/mcp-proxy/${id}/docs`, `Bearer ${token}`),
          await api("/v1/files/file_scope", sandboxBasicCredential(id, token)),
        ]) {
          if (expected === 401) expect(response.status).toBe(401);
          else expect(response.status).not.toBe(401);
        }
      }
    } finally {
      for (const id of [outside.id, inside.id]) await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });
});

describe("Cloudflare native credential egress RPC", () => {
  // createEgressRelayPasses imports exactly this HMAC key; the RPC must never mint one.
  const relayPassKeys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([format, data]) =>
    format === "raw" && new TextDecoder().decode(data as Uint8Array).startsWith("credential-relay.v2:")).length;

  it("serves resolve and forward for the binding's current sandbox token only: 401 once it is not current, a new attempt's token restores it (design §0.0b B)", async () => {
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
    const upstream: Array<{ url: string; method: string; headers: Headers; body: Uint8Array }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(input);
      upstream.push({ url: request.url, method: request.method, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(new Uint8Array([1, 255]), { status: 201, headers: { connection: "x-hop", "x-hop": "strip", "x-upstream": "keep" } });
    });
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const first = await runningAttempt(id);
    const tokenSha256 = (await sandboxTokenSha256(await first.token()))!;
    const egress = (action: "resolve" | "forward", request: Request, sha: string | null = tokenSha256) =>
      env.MAIN_MCP.credentialEgress({ tenantId: "default", sessionId: id, ...(sha === null ? {} : { tokenSha256: sha }) }, action, request);
    const post = (url = target) => new Request(url, { method: "POST", body: new Uint8Array([0, 255, 128]), headers: {
      authorization: "Bearer __cap_managed__", "proxy-authorization": "strip", "x-client": "keep",
    } });
    const denied = async (response: Response, status: number, text: string) => {
      expect(response.status).toBe(status); expect(await response.text()).toBe(text);
    };
    try {
      expect(await (await egress("resolve", new Request(target))).json()).toEqual({ inject: true });
      expect(await (await egress("resolve", new Request("https://public.example/"))).json()).toEqual({ inject: false });
      // No token bound (between turns), a digest that is no token, another workspace: 401.
      await denied(await egress("resolve", new Request(target), null), 401, "Credential relay request denied");
      await denied(await egress("resolve", new Request(target), "0".repeat(64)), 401, "Credential relay request denied");
      await denied(await env.MAIN_MCP.credentialEgress({ tenantId: "other", sessionId: id, tokenSha256 }, "resolve", new Request(target)), 401, "Credential relay request denied");
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
      await denied(await egress("forward", post("https://public.example/")), 403, "Credential relay request denied");
      await denied(await egress("forward", post("http://rpc-authority.example/mcp")), 400, "Credential relay request denied");
      await denied(await egress("resolve", new Request(`${target}#fragment`)), 400, "Credential relay request denied");
      // The attempt ends: its token is refused, also before buffering a body.
      await first.settle();
      await denied(await egress("resolve", new Request(target)), 401, "Credential relay request denied");
      await denied(await egress("forward", new Request(target, { method: "POST" })), 401, "Credential relay request denied");
      // The next attempt's token restores Vault; the old one stays refused.
      const second = await runningAttempt(id);
      const next = (await sandboxTokenSha256(await second.token()))!;
      expect(await (await egress("resolve", new Request(target), next)).json()).toEqual({ inject: true });
      await denied(await egress("resolve", new Request(target)), 401, "Credential relay request denied");
      await env.MAIN_DB.prepare("UPDATE managed_sessions SET archived_at=? WHERE workspace_id='default' AND id=?").bind(Date.now(), id).run();
      await denied(await egress("resolve", new Request(target), next), 401, "Credential relay request denied");
      await denied(await egress("forward", post(), next), 401, "Credential relay request denied");
      expect(upstream).toEqual([]);
      expect(relayPassKeys(importKey)).toBe(0);
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(id).run();
    }
  });

  it("GitHub credential lookup only for the binding's current sandbox token", async () => {
    await exports.default.fetch(new Request("http://localhost/health"));
    const sessionId = `relay-gh-${crypto.randomUUID()}`;
    await env.MAIN_DB.prepare(`INSERT INTO managed_sessions
      (workspace_id,id,document,revision,agent_id,agent_version,environment_id,status,created_at,updated_at,archived_at)
      VALUES ('default',?,?,1,'agent',1,'environment','idle',?,?,NULL)`)
      .bind(sessionId, JSON.stringify({ vaultIds: [], resources: [] }), Date.now(), Date.now()).run();
    const attempt = await runningAttempt(sessionId);
    const tokenSha256 = (await sandboxTokenSha256(await attempt.token()))!;
    const lookup = (sha?: string) => env.MAIN_MCP.lookupGithubCredential({
      tenantId: "default", sessionId, hostname: "github.com", pathname: "/acme/app", ...(sha === undefined ? {} : { tokenSha256: sha }),
    });
    try {
      // No github_repository resource: null either way; no token or a refused one never reads resources.
      await expect(lookup(tokenSha256)).resolves.toBeNull();
      await expect(lookup()).resolves.toBeNull();
      await attempt.settle();
      await expect(lookup(tokenSha256)).resolves.toBeNull();
    } finally {
      await env.MAIN_DB.prepare("DELETE FROM managed_sessions WHERE workspace_id='default' AND id=?").bind(sessionId).run();
    }
  });
});
