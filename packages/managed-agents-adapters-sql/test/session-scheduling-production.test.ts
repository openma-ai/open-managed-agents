/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { CfD1SqlClient } from "../../sql-client/src/adapters/cf-d1";
import { SqlManagedSessionsComposition } from "../src/managed-sessions-composition";
import { EnvironmentAwareSessionEventDispatchRouter } from "../../managed-agents-adapters-runtime/src/session-lifecycle-router";
import { EnvironmentWorkEnqueuerService, admitAllSessionCreates } from "@open-managed-agents/managed-agents-application";
import { SqlEnvironmentWorkStore } from "../../environment-work-store-sql/src";
import { createNodeEnvironmentWorkWorker } from "../../control-plane-node/src/lib/node-environment-work-worker";
import { buildSessionEventRoutes } from "../../managed-agents-api/src/routes/session-events";

// Only shard inventory is substituted; SQL, app composition, HTTP routes,
// cron handler, credentials and recovery are the production implementations.
const shard = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock("../../services/src/index", async importOriginal => ({
  ...await importOriginal<object>(),
  forEachShardServices: async (_env: unknown, action: (services: unknown, name: string) => Promise<unknown>) => [await action({ kv: {
    get: async (key: string) => shard.kv.get(key) ?? null,
    put: async (key: string, value: string) => { shard.kv.set(key, value); },
    delete: async (key: string) => { shard.kv.delete(key); },
  } }, "DB")],
}));

const schema = `
CREATE TABLE managed_sessions (workspace_id text,id text,document text,revision integer,environment_id text,created_at integer,updated_at integer,archived_at integer,status text,PRIMARY KEY(workspace_id,id));
CREATE TABLE managed_environments (workspace_id text,id text,document text,created_at integer,updated_at integer,archived_at integer,PRIMARY KEY(workspace_id,id));
CREATE TABLE managed_session_events (workspace_id text,session_id text,thread_id text,id text,type text,document text,processed_at integer,PRIMARY KEY(workspace_id,session_id,id));
CREATE TABLE managed_session_initial_events (workspace_id text,session_id text,sequence integer,document text);
CREATE TABLE managed_environment_work (workspace_id text,environment_id text,id text,session_id text,document text,sealed_secret text,claim_at integer,claim_worker_id text,claim_generation integer,heartbeat_ttl_seconds integer,revision integer,state text,created_at integer,PRIMARY KEY(workspace_id,id));
`;
const time = "2026-11-10T00:00:00.000Z";
async function fixture(sql: SqlClient) {
  await sql.exec(schema);
  const environment = { id: "env", archivedAt: null, config: { type: "cloud" }, createdAt: time, updatedAt: time } as never;
  await sql.prepare("INSERT INTO managed_environments VALUES ('ws','env',?,0,0,NULL)").bind(JSON.stringify(environment)).run();
  for (const id of ["http", "tick"]) {
    const session = { id, environmentId: "env", archivedAt: null, status: "idle", updatedAt: time, outcomeEvaluations: [], resources: [], agent: { skills: [], openma: { harness: "acp-sandbox" } } };
    await sql.prepare("INSERT INTO managed_sessions VALUES ('ws',?,?,1,'env',0,0,NULL,'idle')").bind(id, JSON.stringify(session)).run();
  }
  let sequence = 0;
  const enqueuer = new EnvironmentWorkEnqueuerService({ workspaceId: "ws", store: new SqlEnvironmentWorkStore(sql, {
    seal: async ({ plaintext }) => ({ ciphertext: plaintext }), open: async ({ ciphertext }) => ({ plaintext: ciphertext }),
  }), credentials: { issue: async () => ({ type: "issued", secret: { sessionsToken: "test" } }), bindToClaim: async ({ secret }) => ({ secret }) },
    wakeup: { notifyRunStarted: async () => {} }, clock: { now: () => new Date(time) }, ids: { nextEnvironmentWorkId: () => "work_" + ++sequence } });
  const router = new EnvironmentAwareSessionEventDispatchRouter({ selfHostedWork: enqueuer,
    runtime: { sessionEventsAccepted: async () => { throw new Error("unexpected second execution brain"); } } });
  const create = (crash = false) => new SqlManagedSessionsComposition({ client: sql, environments: { find: async () => environment },
    lifecycle: { sessionStarted: async () => {}, sessionStopped: async () => {} }, admission: admitAllSessionCreates,
    runtime: { sessionEventsAccepted: async () => { throw new Error("unexpected host execution"); }, sessionThreadArchived: async () => {}, async *subscribe() {} },
    eventDispatch: { sessionEventsAccepted: async input => { if (crash) throw new Error("crash after append"); await router.sessionEventsAccepted(input); },
      recoverSessionScheduling: input => router.recoverSessionScheduling(input) },
    sealer: { seal: async value => value }, clock: { now: () => new Date(time) },
    ids: { nextEventId: () => "event_" + ++sequence, nextSessionId: () => "unused", nextOutcomeId: () => "outcome", nextResourceId: () => "resource" } });
  const send = (composition: SqlManagedSessionsComposition, id: string) => {
    const routes = buildSessionEventRoutes(composition.portsFor("ws").sessionEvents);
    routes.onError(() => new Response("injected failure", { status: 500 }));
    return routes.request("/" + id + "/events", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: "continue" }] }] }) });
  };
  return { create, send };
}

describe.each(["sqlite", "d1"])("production recovery composition on %s", backend => {
  it("HTTP retry and a reconstructed bounded recovery tick need no manually injected recovery", async () => {
    let dispose = async () => {};
    let sql: SqlClient;
    let d1: D1Database | undefined;
    if (backend === "d1") {
      const require = createRequire(import.meta.url);
      const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
      const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('test') } }", compatibilityDate: "2026-11-01", d1Databases: ["DB"] }));
      d1 = await mf.getD1Database("DB");
      sql = new CfD1SqlClient(d1!); dispose = () => mf.dispose();
    } else sql = await createBetterSqlite3SqlClient(":memory:");
    try {
      const f = await fixture(sql);
      const dead = f.create(true);
      expect((await f.send(dead, "http")).status).toBe(500);
      expect((await f.send(dead, "tick")).status).toBe(500);
      await dead.stopAll();
      const live = f.create();
      expect((await f.send(live, "http")).status).toBe(200);
      expect(await sql.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'http'").first()).toEqual({ n: 1 });
      if (backend === "d1") {
        const { buildCfScheduler } = await import("../../../apps/main/src/lib/cf-scheduler-jobs");
        const scheduler = buildCfScheduler({ DB: d1, PLATFORM_ROOT_SECRET: "test-root-secret-32-characters-long", PUBLIC_BASE_URL: "https://example.test" } as never);
        const job = scheduler.list().find(job => job.name === "session-work-recovery")!;
        expect(job.cron).toBe("* * * * *");
        await job.handler();
      } else {
        const host = createNodeEnvironmentWorkWorker({ config: { sandbox: { environment: {} }, http: {} },
          sql, work: {}, application: () => ({}), capabilities: {}, sandboxes: {}, recovery: live,
          onError: () => { throw new Error("unexpected recovery error"); } } as never);
        await host.start(); await host.stop();
      }
      expect(await sql.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'tick'").first()).toEqual({ n: 1 });
      await f.create().recoverSchedulingPage({ limit: 20 });
      expect(await sql.prepare("SELECT count(*) AS n FROM managed_environment_work").first()).toEqual({ n: 2 });
      const events = (await sql.prepare("SELECT document FROM managed_session_events").all<{document:string}>()).results!;
      expect(events).toHaveLength(2);
      expect(events.map(row => JSON.parse(row.document).processedAt)).toEqual([null, null]);
      await live.stopAll();
    } finally { await dispose(); }
  });
});
