// Real Node control-plane process. A local MCP server revokes access
// (not_in_channel). The session scope must close, the pending wakeup must
// cancel, and a second identical result must stay idempotent. A generic 401
// must leave the scope and wakeup alone.

import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { detachedProcessOptions, killProcessTree } from "./helpers/process-tree";

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  log: string[];
}

describe("Node managed MCP proxy access-loss cleanup", () => {
  let dataDir: string | null = null;
  let handle: ProcessHandle | null = null;
  let mock: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    if (handle) await killProcessTree(handle.child);
    handle = null;
    if (mock) {
      await new Promise<void>((resolveClose) => mock!.close(() => resolveClose()));
      mock = null;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it("closes the scope, cancels the wakeup, and ignores a repeated trigger and a generic 401", async () => {
    dataDir = join(tmpdir(), `oma-access-loss-${randomBytes(4).toString("hex")}`);
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "oma.db");

    handle = await startMainNode(dataDir);
    await killProcessTree(handle.child);
    handle = null;

    const mockPort = await pickPort();
    mock = createServer((request, response) => {
      const url = request.url ?? "/";
      if (url.startsWith("/fence")) {
        const db = new Database(dbPath);
        db.pragma("busy_timeout = 5000");
        const now = Date.now();
        db.prepare(
          `INSERT INTO managed_session_executions
             (workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
              events_fingerprint, state, generation, attempt_count, max_attempts,
              deadline_at_ms, revision)
           VALUES ('default', 'sess_fence', 'lane', 'exec_fence', ?, '[]', 'fp', 'running', 1, 1, 10, ?, 1)`,
        ).run(now, now + 60_000);
        db.close();
      }
      const body = url.startsWith("/unauthorized")
        ? { error: "unauthorized" }
        : url.startsWith("/revoked")
          ? { ok: false, error: "token_revoked" }
          : { result: { isError: true, content: [{ type: "text", text: "not_in_channel" }] } };
      const status = url.startsWith("/unauthorized") ? 401 : 200;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolveListen) => mock!.listen(mockPort, "127.0.0.1", () => resolveListen()));

    const db = new Database(dbPath);
    const now = Date.now();
    seed(db, {
      id: "sess_lost",
      serverName: "slack",
      url: `http://127.0.0.1:${mockPort}/lost`,
      publicationId: "pub_lost",
      scopeKey: "channel:C123",
      wakeup: true,
      now,
    });
    seed(db, {
      id: "sess_401",
      serverName: "slack",
      url: `http://127.0.0.1:${mockPort}/unauthorized`,
      publicationId: "pub_401",
      scopeKey: "channel:C401",
      wakeup: true,
      now,
    });
    seed(db, {
      id: "sess_revoked",
      serverName: "slack",
      url: `http://127.0.0.1:${mockPort}/revoked`,
      publicationId: "pub_revoked",
      scopeKey: "channel:Crev",
      wakeup: true,
      now,
    });
    seed(db, {
      id: "sess_fence",
      serverName: "slack",
      url: `http://127.0.0.1:${mockPort}/fence`,
      publicationId: "pub_fence",
      scopeKey: "channel:Cfence",
      wakeup: false,
      now,
    });
    db.close();

    handle = await startMainNode(dataDir);
    const lostBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slack_post_message", arguments: { channel_id: "C123" } },
    });
    const first = await post(handle.port, "sess_lost", lostBody);
    const second = await post(handle.port, "sess_lost", lostBody);
    const unauthorized = await post(handle.port, "sess_401", "{}");
    const revoked = await post(handle.port, "sess_revoked", "{}");
    const fenced = await post(handle.port, "sess_fence", "{}");

    expect(first.status).toBe(200);
    expect(first.text).toContain("not_in_channel");
    expect(second.status).toBe(200);
    expect(unauthorized.status).toBe(401);
    expect(revoked.status).toBe(200);
    expect(fenced.status).toBe(200);

    const report = readReport(dbPath);
    console.log(JSON.stringify(report, null, 2));
    expect(report.scopes).toEqual({
      sess_lost: "completed",
      sess_401: "active",
      sess_revoked: "active",
      sess_fence: "active",
    });
    expect(report.wakeups).toEqual({
      sess_lost: "cancelled",
      sess_401: "pending",
      sess_revoked: "pending",
    });
    expect(report.appliedEffects.filter((row) => row.session_id === "sess_lost")).toHaveLength(1);
    expect(report.reauth).toEqual([{ session_id: "sess_revoked", code: "token_revoked", status: "pending" }]);
    expect(report.effects.find((row) => row.session_id === "sess_fence")?.status).toBe("superseded");
    expect(report.lostScan).toBeNull();
  }, 120_000);
});

function seed(
  db: Database.Database,
  input: {
    id: string;
    serverName: string;
    url: string;
    publicationId: string;
    scopeKey: string;
    wakeup: boolean;
    now: number;
  },
) {
  const snapshot = {
    name: "access-loss",
    model: "claude-sonnet-4-6",
    system: "test",
    mcp_servers: [{
      name: input.serverName,
      type: "url",
      url: input.url,
      authorization_token: "upstream-token",
    }],
  };
  db.prepare(
    `INSERT INTO sessions
       (id, tenant_id, agent_id, environment_id, title, status, agent_snapshot, metadata, created_at, updated_at)
     VALUES (?, 'default', 'agent_test', 'env_test', '', 'idle', ?, ?, ?, ?)`,
  ).run(
    input.id,
    JSON.stringify(snapshot),
    JSON.stringify({ slack: { publicationId: input.publicationId, channelId: "C123" } }),
    input.now,
    input.now,
  );
  db.prepare(
    `INSERT INTO slack_thread_sessions
       (publication_id, tenant_id, scope_key, session_id, status, created_at, pending_scan_until, channel_name)
     VALUES (?, 'default', ?, ?, 'active', ?, ?, 'general')`,
  ).run(input.publicationId, input.scopeKey, input.id, input.now, input.now + 60_000);
  if (input.wakeup) {
    db.prepare(
      `INSERT INTO session_wakeups
         (id, workspace_id, session_id, prompt, kind, fire_at, status, created_at)
       VALUES (?, 'default', ?, 'scan channel', 'one_shot', ?, 'pending', ?)`,
    ).run(`wake_${input.id}`, input.id, new Date(input.now + 3_600_000).toISOString(), new Date(input.now).toISOString());
  }
}

function readReport(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
  const scopes = Object.fromEntries(
    (db.prepare(`SELECT session_id, status FROM slack_thread_sessions`).all() as Array<{
      session_id: string;
      status: string;
    }>).map((row) => [row.session_id, row.status]),
  );
  const wakeups = Object.fromEntries(
    (db.prepare(`SELECT session_id, status FROM session_wakeups`).all() as Array<{
      session_id: string;
      status: string;
    }>).map((row) => [row.session_id, row.status]),
  );
  const effects = db.prepare(
    `SELECT session_id, status, code, publication_id FROM mcp_access_loss_effects ORDER BY session_id`,
  ).all() as Array<{ session_id: string; status: string; code: string; publication_id: string | null }>;
  const reauth = db.prepare(
    `SELECT session_id, code, status FROM mcp_reauthorization_requests ORDER BY session_id`,
  ).all() as Array<{ session_id: string; code: string; status: string }>;
  const lostScan = db.prepare(
    `SELECT pending_scan_until AS until FROM slack_thread_sessions WHERE session_id = 'sess_lost'`,
  ).get() as { until: number | null };
  db.close();
  return {
    scopes,
    wakeups,
    effects,
    appliedEffects: effects.filter((row) => row.status === "applied"),
    reauth,
    lostScan: lostScan.until,
  };
}

async function post(port: number, sessionId: string, body: string) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/oma/mcp-proxy/${sessionId}/slack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function startMainNode(dataDir: string): Promise<ProcessHandle> {
  const port = await pickPort();
  const child = spawn(TSX_BIN, [MAIN_NODE_ENTRY], {
    ...detachedProcessOptions,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(dataDir, "oma.db"),
      AUTH_DATABASE_PATH: join(dataDir, "auth.db"),
      SANDBOX_WORKDIR: join(dataDir, "sandboxes"),
      MEMORY_BLOB_DIR: join(dataDir, "memory-blobs"),
      AUTH_DISABLED: "1",
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest-do-not-deploy",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`main-node exited ${child.exitCode}\n${log.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { child, port, log };
    } catch {
      /* not listening yet */
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  }
  await killProcessTree(child);
  throw new Error(`main-node did not become ready\n${log.join("")}`);
}

function pickPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const port = address.port;
        server.close(() => resolvePort(port));
      } else {
        rejectPort(new Error("could not pick a port"));
      }
    });
  });
}
