// @ts-nocheck
//
// Issue #25 reproduction. A managed MCP tool result that means "this
// session no longer has access" must close that provider scope and cancel
// the session's pending wakeups. Generic 401 / 5xx must not.
//
// This drives the real Cloudflare test worker (workerd): D1 session row,
// integrations scope row, SessionDO wakeup, then POST /v1/oma/mcp-proxy.

import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const HEADERS = {
  "x-api-key": "test-key",
  "content-type": "application/json",
};

const UPSTREAM = "https://mcp.access-loss.test";

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function ensureSessionsTable() {
  await env.MAIN_DB.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (
       id TEXT PRIMARY KEY NOT NULL,
       tenant_id TEXT NOT NULL,
       agent_id TEXT,
       environment_id TEXT,
       title TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL,
       vault_ids TEXT,
       agent_snapshot TEXT,
       environment_snapshot TEXT,
       metadata TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER,
       archived_at INTEGER,
       turn_id TEXT,
       turn_started_at INTEGER,
       terminated_at INTEGER
     )`,
  ).run();
}

async function insertSession(input: {
  id: string;
  serverName: string;
  metadata: Record<string, unknown>;
}) {
  const now = Date.now();
  const snapshot = {
    name: "access-loss",
    model: "claude-sonnet-4-6",
    system: "test",
    mcp_servers: [{
      name: input.serverName,
      type: "url",
      url: `${UPSTREAM}/${input.id}`,
      authorization_token: "upstream-token",
    }],
  };
  await env.MAIN_DB.prepare(
    `INSERT INTO sessions
       (id, tenant_id, agent_id, environment_id, title, status, agent_snapshot, metadata, created_at, updated_at)
     VALUES (?, 'default', 'agent_test', 'env_test', '', 'idle', ?, ?, ?, ?)`,
  ).bind(
    input.id,
    JSON.stringify(snapshot),
    JSON.stringify(input.metadata),
    now,
    now,
  ).run();
}

async function scheduleWakeup(sessionId: string, prompt: string) {
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
  await stub.fetch(new Request("http://internal/status"));
  let scheduled: { id: string };
  await runInDurableObject(stub, async (instance: {
    state: Record<string, unknown>;
    setState: (state: Record<string, unknown>) => void;
    scheduleWakeup: (args: { delay_seconds: number; prompt: string }) => Promise<{ id: string }>;
    listWakeups: () => Array<{ id: string; prompt: string }>;
  }) => {
    instance.setState({
      ...instance.state,
      session_id: sessionId,
      tenant_id: "default",
    });
    scheduled = await instance.scheduleWakeup({
      delay_seconds: 3600,
      prompt,
    });
  });
  return scheduled!;
}

async function listWakeups(sessionId: string) {
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
  let listed: Array<{ id: string; prompt: string }> = [];
  await runInDurableObject(stub, async (instance: {
    listWakeups: () => Array<{ id: string; prompt: string }>;
  }) => {
    listed = instance.listWakeups();
  });
  return listed;
}

function installUpstream(handler: (url: string) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith(UPSTREAM)) return handler(request.url);
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function scopeStatus(table: string, sessionId: string) {
  const row = await env.INTEGRATIONS_DB.prepare(
    `SELECT status, pending_scan_until FROM ${table} WHERE session_id = ?`,
  ).bind(sessionId).first<{ status: string; pending_scan_until: number | null }>();
  return row;
}

describe("managed MCP proxy access-loss cleanup", () => {
  const restore: Array<() => void> = [];
  beforeAll(async () => {
    const health = await api("/health");
    expect(health.status).toBe(200);
  });
  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
  });

  it("closes the Slack scope and cancels the wakeup when upstream says not_in_channel, and a repeat is a no-op", async () => {
    await ensureSessionsTable();
    const sessionId = `sess_slack_${Math.random().toString(36).slice(2, 10)}`;
    await insertSession({
      id: sessionId,
      serverName: "slack",
      metadata: { slack: { publicationId: "pub_slack", channelId: "C123" } },
    });
    await env.INTEGRATIONS_DB.prepare(
      `INSERT INTO slack_thread_sessions
         (publication_id, tenant_id, scope_key, session_id, status, created_at, pending_scan_until, channel_name)
       VALUES ('pub_slack', 'default', 'channel:C123', ?, 'active', ?, ?, 'general')`,
    ).bind(sessionId, Date.now(), Date.now() + 60_000).run();
    const wakeup = await scheduleWakeup(sessionId, "scan channel C123");
    expect((await listWakeups(sessionId)).map((item) => item.id)).toContain(wakeup.id);

    const lost = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { isError: true, content: [{ type: "text", text: "not_in_channel" }] },
    });
    restore.push(installUpstream(() => new Response(lost, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slack_post_message", arguments: { channel_id: "C123" } },
    });
    const first = await api(`/v1/oma/mcp-proxy/${sessionId}/slack`, {
      method: "POST",
      headers: HEADERS,
      body,
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("not_in_channel");

    const scope = await scopeStatus("slack_thread_sessions", sessionId);
    expect(scope?.status).toBe("completed");
    expect(scope?.pending_scan_until).toBeNull();
    expect(await listWakeups(sessionId)).toEqual([]);

    const second = await api(`/v1/oma/mcp-proxy/${sessionId}/slack`, {
      method: "POST",
      headers: HEADERS,
      body,
    });
    expect(second.status).toBe(200);
    expect((await scopeStatus("slack_thread_sessions", sessionId))?.status).toBe("completed");
    expect(await listWakeups(sessionId)).toEqual([]);
    const effects = await env.MAIN_DB.prepare(
      `SELECT status FROM mcp_access_loss_effects WHERE session_id = ?`,
    ).bind(sessionId).all<{ status: string }>();
    expect(effects.results?.filter((row) => row.status === "applied")).toHaveLength(1);
  });

  it("does not close a scope or cancel a wakeup on a generic 401", async () => {
    await ensureSessionsTable();
    const sessionId = `sess_401_${Math.random().toString(36).slice(2, 10)}`;
    await insertSession({
      id: sessionId,
      serverName: "slack",
      metadata: { slack: { publicationId: "pub_401" } },
    });
    await env.INTEGRATIONS_DB.prepare(
      `INSERT INTO slack_thread_sessions
         (publication_id, tenant_id, scope_key, session_id, status, created_at)
       VALUES ('pub_401', 'default', 'channel:C9', ?, 'active', ?)`,
    ).bind(sessionId, Date.now()).run();
    await scheduleWakeup(sessionId, "keep this wakeup");
    restore.push(installUpstream(() => new Response(
      JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));

    const unauthorized = await api(`/v1/oma/mcp-proxy/${sessionId}/slack`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);
    expect((await scopeStatus("slack_thread_sessions", sessionId))?.status).toBe("active");
    expect(await listWakeups(sessionId)).toHaveLength(1);
  });

  it("does not treat a 500 that mentions not_in_channel as lost access", async () => {
    await ensureSessionsTable();
    const sessionId = `sess_500_${Math.random().toString(36).slice(2, 10)}`;
    await insertSession({
      id: sessionId,
      serverName: "slack",
      metadata: { slack: { publicationId: "pub_500" } },
    });
    await env.INTEGRATIONS_DB.prepare(
      `INSERT INTO slack_thread_sessions
         (publication_id, tenant_id, scope_key, session_id, status, created_at)
       VALUES ('pub_500', 'default', 'channel:C8', ?, 'active', ?)`,
    ).bind(sessionId, Date.now()).run();
    restore.push(installUpstream(() => new Response(
      JSON.stringify({ error: "not_in_channel" }),
      { status: 500, headers: { "content-type": "application/json" } },
    )));

    const response = await api(`/v1/oma/mcp-proxy/${sessionId}/slack`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    expect(response.status).toBe(500);
    expect((await scopeStatus("slack_thread_sessions", sessionId))?.status).toBe("active");
  });

  it("closes a Linear issue scope on issue_not_found and a GitHub scope on repository_not_found", async () => {
    await ensureSessionsTable();
    const linearId = `sess_linear_${Math.random().toString(36).slice(2, 10)}`;
    const githubId = `sess_github_${Math.random().toString(36).slice(2, 10)}`;
    await insertSession({
      id: linearId,
      serverName: "linear",
      metadata: { linear: { publicationId: "pub_linear" } },
    });
    await insertSession({
      id: githubId,
      serverName: "github",
      metadata: { github: { publicationId: "pub_github" } },
    });
    await env.INTEGRATIONS_DB.prepare(
      `INSERT INTO linear_issue_sessions
         (publication_id, tenant_id, issue_id, session_id, status, created_at)
       VALUES ('pub_linear', 'default', 'issue_1', ?, 'active', ?)`,
    ).bind(linearId, Date.now()).run();
    await env.INTEGRATIONS_DB.prepare(
      `INSERT INTO github_issue_sessions
         (publication_id, tenant_id, issue_id, session_id, status, created_at)
       VALUES ('pub_github', 'default', 'acme/app#1', ?, 'active', ?)`,
    ).bind(githubId, Date.now()).run();
    restore.push(installUpstream((url) => {
      const body = url.includes(linearId)
        ? { error: "issue_not_found" }
        : { error: "repository_not_found" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    expect((await api(`/v1/oma/mcp-proxy/${linearId}/linear`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "get_issue", arguments: { issue_id: "issue_1" } },
      }),
    })).status).toBe(200);
    expect((await api(`/v1/oma/mcp-proxy/${githubId}/github`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "get_file", arguments: { repository: "acme/app" } },
      }),
    })).status).toBe(200);

    const linear = await env.INTEGRATIONS_DB.prepare(
      `SELECT status FROM linear_issue_sessions WHERE session_id = ?`,
    ).bind(linearId).first();
    const github = await env.INTEGRATIONS_DB.prepare(
      `SELECT status FROM github_issue_sessions WHERE session_id = ?`,
    ).bind(githubId).first();
    expect(linear?.status).toBe("inactive");
    expect(github?.status).toBe("inactive");
    const linearEffect = await env.MAIN_DB.prepare(
      `SELECT publication_id, resource_id, status FROM mcp_access_loss_effects WHERE session_id = ?`,
    ).bind(linearId).first();
    expect(linearEffect).toMatchObject({
      publication_id: "pub_linear",
      resource_id: "issue_1",
      status: "applied",
    });
  });

  it("pauses a revoked credential without closing the Slack scope or cancelling its wakeup", async () => {
    await ensureSessionsTable();
    const sessionId = `sess_revoked_${Math.random().toString(36).slice(2, 10)}`;
    await insertSession({
      id: sessionId,
      serverName: "slack",
      metadata: { slack: { publicationId: "pub_revoked" } },
    });
    await env.INTEGRATIONS_DB.prepare(
      `INSERT INTO slack_thread_sessions
         (publication_id, tenant_id, scope_key, session_id, status, created_at)
       VALUES ('pub_revoked', 'default', 'channel:C7', ?, 'active', ?)`,
    ).bind(sessionId, Date.now()).run();
    await scheduleWakeup(sessionId, "do not cancel me");
    restore.push(installUpstream(() => new Response(
      JSON.stringify({ ok: false, error: "token_revoked" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const response = await api(`/v1/oma/mcp-proxy/${sessionId}/slack`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect((await scopeStatus("slack_thread_sessions", sessionId))?.status).toBe("active");
    expect(await listWakeups(sessionId)).toHaveLength(1);
    const reauth = await env.MAIN_DB.prepare(
      `SELECT code, status FROM mcp_reauthorization_requests WHERE session_id = ?`,
    ).bind(sessionId).first();
    expect(reauth).toMatchObject({ code: "token_revoked", status: "pending" });

    await api(`/v1/oma/mcp-proxy/${sessionId}/slack`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    const rows = await env.MAIN_DB.prepare(
      `SELECT id FROM mcp_reauthorization_requests WHERE session_id = ?`,
    ).bind(sessionId).all();
    expect(rows.results).toHaveLength(1);
  });

  it("does not close a scope when a newer execution generation appears during the upstream call", async () => {
    await ensureSessionsTable();
    const sessionId = `sess_fence_${Math.random().toString(36).slice(2, 10)}`;
    await insertSession({
      id: sessionId,
      serverName: "slack",
      metadata: { slack: { publicationId: "pub_fence" } },
    });
    await env.INTEGRATIONS_DB.prepare(
      `INSERT INTO slack_thread_sessions
         (publication_id, tenant_id, scope_key, session_id, status, created_at)
       VALUES ('pub_fence', 'default', 'channel:C4', ?, 'active', ?)`,
    ).bind(sessionId, Date.now()).run();
    restore.push(installUpstream(async () => {
      const now = Date.now();
      await env.MAIN_DB.prepare(
        `INSERT INTO managed_session_executions
           (workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
            events_fingerprint, state, generation, attempt_count, max_attempts,
            deadline_at_ms, revision)
         VALUES ('default', ?, 'lane', ?, ?, '[]', 'fp', 'running', 1, 1, 10, ?, 1)`,
      ).bind(sessionId, `exec_${sessionId}`, now, now + 60_000).run();
      return new Response(JSON.stringify({ error: "not_in_channel" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const response = await api(`/v1/oma/mcp-proxy/${sessionId}/slack`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect((await scopeStatus("slack_thread_sessions", sessionId))?.status).toBe("active");
    const effect = await env.MAIN_DB.prepare(
      `SELECT status FROM mcp_access_loss_effects WHERE session_id = ?`,
    ).bind(sessionId).first();
    expect(effect?.status).toBe("superseded");
  });
});
