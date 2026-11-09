// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.restoreAllMocks());
import { sandboxBasicCredential } from "../../packages/sandbox-gateway/src/index";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
/** The pre-#561 HMAC relay pass, signed the way the removed issuer did (deploy transition only). */
async function legacyPass(claims: Record<string, unknown>) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`credential-relay.v2:${env.PLATFORM_ROOT_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
}
import { sqlClientFromD1 } from "../../packages/sql-client/src/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "../../packages/environment-work-store-sql/src/index";
import { WebCryptoAesGcm } from "../../packages/integrations-adapters-cf/src/crypto";

/** A self-hosted Session's claimed, active Environment Work in the tenant D1:
 * the binding a Cloudflare host carries is its claim (ADR 0005). */
async function claimedWork(sessionId: string) {
  const cipher = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.environment-work.secret");
  const store = new SqlEnvironmentWorkStore(sqlClientFromD1(env.MAIN_DB), {
    seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }),
    open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }),
  });
  const workId = `work-${crypto.randomUUID()}`;
  const token = `sk-ant-session-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await store.insert({ workspaceId: "default", record: {
    work: { id: workId, acknowledgedAt: now, createdAt: now, data: { type: "session", id: sessionId }, environmentId: "environment",
      latestHeartbeatAt: now, metadata: {}, startedAt: now, state: "active", stopRequestedAt: null, stoppedAt: null },
    secret: { sessionsToken: token, claimGeneration: 1 },
    claim: { claimedAt: now, workerId: "worker", generation: 1 },
    heartbeatTtlSeconds: 600,
  } });
  return { environmentId: "environment", workId, ownerId: "owner", generation: 1, token };
}

/** A running execution attempt for `sessionId`: Session sandbox credentials
 * (relay pass, native egress) are bound to it (design §0.0 rule 10). */
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
    token: (harness: string | null = null) => env.MAIN_MCP.issueSandboxEgressToken({ tenantId: "default", sessionId, attempt: { workspaceId: "default", sessionId, ...fence }, harness }),
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
      // Deploy transition: a pre-#561 pass verifies only for the running attempt.
      expect((await call(`Bearer ${legacy}`)).status).toBe(200);
      expect((await call(`Bearer ${staleLegacy}`)).status).toBe(401); // was 403: a definite rejection is now 401 (the forwarder exits on it)
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

  it("serves resolve and forward without a relay pass, keeping fence and Session denials; no fence → denied (design §0.0 rule 10)", async () => {
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
    const runtimeFence = await claimedWork(id);
    const upstream: Array<{ url: string; method: string; headers: Headers; body: Uint8Array }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(input);
      upstream.push({ url: request.url, method: request.method, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(new Uint8Array([1, 255]), { status: 201, headers: { connection: "x-hop", "x-hop": "strip", "x-upstream": "keep" } });
    });
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const egress = (action: "resolve" | "forward", request: Request, fence: unknown = runtimeFence) =>
      env.MAIN_MCP.credentialEgress({ tenantId: "default", sessionId: id, ...(fence === null ? {} : { runtimeFence: fence }) }, action, request);
    const post = (url = target) => new Request(url, { method: "POST", body: new Uint8Array([0, 255, 128]), headers: {
      authorization: "Bearer __cap_managed__", "proxy-authorization": "strip", "x-client": "keep",
    } });
    try {
      expect(await (await egress("resolve", new Request(target))).json()).toEqual({ inject: true });
      expect(await (await egress("resolve", new Request("https://public.example/"))).json()).toEqual({ inject: false });
      // Deliberate (design §0.0 rule 10): without a fence the RPC no longer injects.
      const noFence = await egress("resolve", new Request(target), null);
      expect(noFence.status).toBe(403);
      // A Session sandbox's execution attempt: injected while current, denied once it ends.
      const attempt = await runningAttempt(id);
      const executionEgress = (action: "resolve" | "forward", request: Request) =>
        env.MAIN_MCP.credentialEgress({ tenantId: "default", sessionId: id, executionFence: attempt.fence }, action, request);
      expect(await (await executionEgress("resolve", new Request(target))).json()).toEqual({ inject: true });
      expect((await executionEgress("resolve", new Request(target))).status).toBe(200);
      const staleExecution = await env.MAIN_MCP.credentialEgress({ tenantId: "default", sessionId: id, executionFence: { ...attempt.fence, attemptId: "previous" } }, "resolve", new Request(target));
      expect(staleExecution.status).toBe(403);
      await attempt.settle();
      expect((await executionEgress("resolve", new Request(target))).status).toBe(403);
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
      await denied(await egress("resolve", new Request(target), { ...runtimeFence, generation: 2 }), 403, "Credential relay denied");
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

  it("GitHub credential lookup fails closed on a stale Environment Work claim (characterization)", async () => {
    await exports.default.fetch(new Request("http://localhost/health"));
    const sessionId = `relay-gh-${crypto.randomUUID()}`;
    const claim = await claimedWork(sessionId);
    const lookup = (binding: typeof claim) => env.MAIN_MCP.lookupGithubCredential({
      tenantId: "default", sessionId, hostname: "github.com", pathname: "/acme/app", runtimeFence: binding,
    });
    await expect(lookup(claim)).resolves.toBeNull();
    // Settled here: an RPC promise handed to expect().rejects is reported as unhandled.
    for (const stale of [{ ...claim, token: "stale-token" }, { ...claim, generation: 2 }]) {
      const error = await lookup(stale).then(() => null, (failure: Error) => failure);
      expect(error?.message).toMatch(/stale Environment Work claim/);
    }
  });
});
