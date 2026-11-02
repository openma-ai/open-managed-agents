/**
 * Two Matter replicas sharing one MySQL database: any replica serves any
 * request. Runs when MATTER_TEST_MYSQL_URL points at a MySQL server whose
 * user may create databases, for example
 * `MATTER_TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:3306/mysql`.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSecretBox, openMysqlMatterDatabase, type MatterDatabase } from "../src/persistence.js";
import { createMatterService, loadMatterConfig, type MatterConfig, type MatterService } from "../src/server.js";
import { OperationCallBridge } from "../src/tool-bridge.js";
import { FakeOma } from "./fake-oma.js";

const ROOT_URL = process.env.MATTER_TEST_MYSQL_URL;
const TOKEN = "glpat-bot-token-value";
const SECRET = "a-long-enough-secret-key";

const note = (text: string) => ({
  object_kind: "note",
  user: { id: 8, username: "bob" },
  project: { id: 42, path_with_namespace: "platform/api" },
  object_attributes: {
    id: 555,
    note: text,
    noteable_type: "MergeRequest",
    system: false,
    discussion_id: "d1",
    created_at: "2026-08-23T08:00:02Z",
  },
  merge_request: { iid: 7, draft: false },
});

const waitFor = async <T>(read: () => T | undefined, ms = 15_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe.skipIf(ROOT_URL === undefined)("replicas sharing MySQL", () => {
  const database = `matter_test_${randomBytes(4).toString("hex")}`;
  let url: string;
  let dir: string;
  let config: MatterConfig;
  let oma: FakeOma;
  let notes: { path: string; body: unknown }[];
  let services: MatterService[];
  const extraDbs: MatterDatabase[] = [];

  const gitlabFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v4/user") return Response.json({ id: 99, username: "oma-bot" });
    if (init?.method === "POST" && path.endsWith("/notes")) {
      notes.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ id: 1000 + notes.length }, { status: 201 });
    }
    return Response.json({ message: "404 Not Found" }, { status: 404 });
  }) as typeof fetch;

  const replica = async () => {
    const service = await createMatterService(config, {
      omaFetch: oma.fetch as typeof fetch,
      fetch: gitlabFetch,
      onError: () => {},
    });
    services.push(service);
    return service;
  };

  beforeAll(async () => {
    const root = await createConnection(ROOT_URL!);
    await root.query(`CREATE DATABASE ${database}`);
    await root.end();
    const parsed = new URL(ROOT_URL!);
    parsed.pathname = `/${database}`;
    url = parsed.toString();
  });

  afterAll(async () => {
    if (ROOT_URL === undefined) return;
    const root = await createConnection(ROOT_URL);
    await root.query(`DROP DATABASE IF EXISTS ${database}`);
    await root.end();
  });

  beforeEach(async () => {
    // Each test starts from no saved connections.
    const conn = await createConnection(url);
    const [tables] = await conn.query(`SHOW TABLES LIKE 'openmatter_gitlab_connections'`);
    if ((tables as unknown[]).length > 0) await conn.query(`DELETE FROM openmatter_gitlab_connections`);
    await conn.end();
    dir = mkdtempSync(join(tmpdir(), "matter-replicas-"));
    oma = new FakeOma();
    oma.agents.set("agent-1", { id: "agent-1", version: 1, mcp_servers: [], tools: [] });
    notes = [];
    services = [];
    config = loadMatterConfig({
      MATTER_DATA_DIR: dir,
      MATTER_DATABASE_URL: url,
      MATTER_PROXY_SECRET: "proxy-secret",
      MATTER_SECRET_KEY: SECRET,
      OMA_URL: "https://oma.test",
      OMA_API_KEY: "test-key",
      OMA_ENVIRONMENT_ID: "env_1",
      MATTER_MCP_URL: "https://matter.test/mcp",
    });
  });

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    for (const db of extraDbs.splice(0)) await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a webhook on a replica that never saw the connection, once across replicas", async () => {
    const a = await replica();
    const b = await replica();
    await b.host.start();
    expect(b.host.running()).toEqual([]);

    const created = await a.fetch(
      new Request("https://matter.test/connect/gitlab", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-matter-proxy-secret": "proxy-secret",
          "x-oma-tenant-id": "default",
        },
        body: JSON.stringify({ baseUrl: "https://gitlab.test", token: TOKEN, agentId: "agent-1", projectIds: [42] }),
      }),
    );
    expect(created.status).toBe(201);
    const { id, webhookSecret } = (await created.json()) as { id: string; webhookSecret: string };
    expect(a.host.running()).toEqual([id]);
    // B lists it from the shared database (the Console may hit either).
    const listed = (await (
      await b.fetch(
        new Request("https://matter.test/connect/gitlab", {
          headers: { "x-matter-proxy-secret": "proxy-secret", "x-oma-tenant-id": "default" },
        }),
      )
    ).json()) as { data: { id: string }[] };
    expect(listed.data.map((c) => c.id)).toEqual([id]);

    let turns = 0;
    oma.responder = (_sessionId, event) => {
      if (event.type !== "user.message") return undefined;
      turns += 1;
      return [
        { type: "agent.message", id: `msg_${turns}`, content: [{ type: "text", text: "Retries back off." }] },
        { type: "session.status_idle", stop_reason: { type: "end_turn" } },
      ];
    };
    const deliver = (service: MatterService) =>
      service.fetch(
        new Request(`https://matter.test/webhooks/gitlab/${id}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gitlab-token": webhookSecret,
            "x-gitlab-event": "Note Hook",
            "x-gitlab-event-uuid": "uuid-shared",
          },
          body: JSON.stringify(note("@oma-bot how do retries work?")),
        }),
      );
    // The same delivery reaches both replicas (GitLab retried through the
    // load balancer). B starts the connection on demand.
    const [toB, toA] = await Promise.all([deliver(b), deliver(a)]);
    expect([toB.status, toA.status]).toEqual([202, 202]);
    expect(b.host.running()).toEqual([id]);

    await waitFor(() => notes[0]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(notes).toHaveLength(1);
    expect(turns).toBe(1);
    expect(oma.sessions.size).toBe(1);
  });

  it("starts a connection another replica saved on reconcile, and keeps an unchanged one", async () => {
    const a = await replica();
    const b = await replica();
    const saved = await a.db.gitlab.save({
      id: "gitlab-00000000000000aa",
      baseUrl: "https://gitlab.test",
      token: TOKEN,
      username: "oma-bot",
      webhookSecret: "s".repeat(32),
      projectIds: [42],
      tenantId: "default",
      agentId: "",
    });
    // A Bond runs once a Loop uses it.
    await b.host.reconcile();
    expect(b.host.running()).toEqual([]);
    await a.db.loops.save({
      id: "loop-1",
      tenantId: "default",
      bondKind: "gitlab",
      bondKey: saved.id,
      template: "gitlab-mention",
      config: { agentId: "agent-1", projects: ["project:42"], username: "oma-bot" },
      enabled: true,
    });
    await b.host.reconcile();
    expect(b.host.running()).toEqual([saved.id]);
    // Saved again (a new revision): still exactly one running copy.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await a.db.gitlab.save({ ...saved, projectIds: [42, 43] });
    await b.host.reconcile();
    expect(b.host.running()).toEqual([saved.id]);
  });

  it("runs an MCP call received by one replica in the Turn another runs", async () => {
    const turnDb = await openMysqlMatterDatabase({ url, box: createSecretBox(SECRET) });
    const mcpDb = await openMysqlMatterDatabase({ url, box: createSecretBox(SECRET) });
    extraDbs.push(turnDb, mcpDb);
    const turnSide = new OperationCallBridge({ store: turnDb.calls, pollMs: 10 });
    const mcpSide = new OperationCallBridge({ store: mcpDb.calls, pollMs: 10 });
    const tools = [{ name: "gitlab.note.create", description: "Post", inputSchema: { type: "object" } }];
    await turnSide.setTools("s-mcp", tools);
    expect(await mcpSide.tools("s-mcp")).toEqual(tools);
    const call = mcpSide.call("s-mcp", "gitlab_note_create", { body: "hi" });
    let taken = (await turnSide.take("s-mcp", "turn-a"))[0];
    while (taken === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      taken = (await turnSide.take("s-mcp", "turn-a"))[0];
    }
    expect(taken).toMatchObject({ tool: "gitlab_note_create", input: { body: "hi" } });
    await turnSide.resolve(taken.callId, { ok: true, result: { status: "sent" } });
    expect(await call).toEqual({ ok: true, result: { status: "sent" } });
    // Two Turns racing for the same calls: each call goes to one, in order.
    const calls = [
      mcpSide.call("s-mcp", "gitlab_note_create", { body: "x" }),
      mcpSide.call("s-mcp", "gitlab_note_create", { body: "y" }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [one, two] = await Promise.all([mcpDb.calls.take("s-mcp", "r1"), turnDb.calls.take("s-mcp", "r2")]);
    const all = [...one!, ...two!];
    expect(all).toHaveLength(2);
    expect(new Set(all.map((c) => c.callId)).size).toBe(2);
    for (const c of all) await turnSide.resolve(c.callId, { ok: true, result: null });
    await Promise.all(calls);
  });

  it("gives a registration's poll to one replica at a time", async () => {
    const one = await openMysqlMatterDatabase({ url, box: createSecretBox(SECRET) });
    const two = await openMysqlMatterDatabase({ url, box: createSecretBox(SECRET) });
    extraDbs.push(one, two);
    const now = Date.now();
    await one.registrations.create({
      id: `reg-${randomBytes(4).toString("hex")}`,
      tenantId: "default",
      deviceCode: "device-code-secret",
      brand: "feishu",
      intervalS: 5,
      expiresAtMs: now + 300_000,
      status: { status: "expired" },
      nextPollAtMs: now - 1,
    });
    const claims = await Promise.all([
      one.registrations.claim(undefined, "replica-1", now, now + 30_000),
      two.registrations.claim(undefined, "replica-2", now, now + 30_000),
    ]);
    expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
    const taken = claims.find((c) => c !== undefined)!;
    expect(taken.deviceCode).toBe("device-code-secret");
    // After the lease runs out the other replica may take it.
    const loser = claims[0] === undefined ? "replica-1" : "replica-2";
    expect(await two.registrations.claim(taken.id, loser, now + 30_001, now + 60_000)).toBeDefined();
  });
});
