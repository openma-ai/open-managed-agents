/// <reference types="@cloudflare/workers-types" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { CfD1SqlClient } from "../../sql-client/src/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "../src";
import { SessionEventsApplicationService } from "../../managed-agents-application/src/session-events/application";
import { SessionSchedulingRecoveryService } from "../../managed-agents-application/src/session-events/scheduling-recovery";
import { SqlSessionEventStore } from "../../session-event-store-sql/src";
import { SqlSessionRuntimeHistorySource } from "../../session-runtime-sql/src/history";
import { EnvironmentAwareSessionEventDispatchRouter } from "../../managed-agents-adapters-runtime/src/session-lifecycle-router";
import { EnvironmentWorkEnqueuerService } from "../../managed-agents-application/src/environment-work/enqueuer-application";
import type { EnvironmentWorkRecord } from "../../environment-work-store/src";

// Use the already installed Wrangler dependency, without adding a manifest or
// substituting SQLite for D1. The binding below is served by local workerd.
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
let mf: InstanceType<typeof Miniflare>;
let client: CfD1SqlClient;
const cipher = { seal: async ({ plaintext }: { plaintext: string }) => ({ ciphertext: plaintext }),
  open: async ({ ciphertext }: { ciphertext: string }) => ({ plaintext: ciphertext }) };
function record(id: string, sessionId: string): EnvironmentWorkRecord {
  return { work: { id, data: { type: "session", id: sessionId }, environmentId: "env", state: "queued",
    createdAt: "2026-11-10T00:00:00.000Z", acknowledgedAt: null, latestHeartbeatAt: null,
    startedAt: null, stopRequestedAt: null, stoppedAt: null, metadata: {} },
    secret: { sessionsToken: "test-" + id }, claim: null, heartbeatTtlSeconds: 90 };
}
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('test') } }",
    compatibilityDate: "2026-11-01", d1Databases: ["DB"] }));
  client = new CfD1SqlClient(await mf.getD1Database("DB"));
  await client.exec(
    "CREATE TABLE managed_sessions (workspace_id text, id text, revision integer, document text, status text, updated_at integer, PRIMARY KEY(workspace_id,id));" +
    "CREATE TABLE managed_environment_work (workspace_id text, environment_id text, id text, session_id text, document text, sealed_secret text, claim_at integer, claim_worker_id text, claim_generation integer, heartbeat_ttl_seconds integer, revision integer, state text, created_at integer, PRIMARY KEY(workspace_id,id));"
  );
});
afterAll(async () => { await mf?.dispose(); });

describe("Session ensure on real local workerd D1", () => {
  it("recovers a committed input after losing dispatch, using the real D1 history and atomic ensure", async () => {
    await client.exec("CREATE TABLE managed_session_events (workspace_id text, session_id text, thread_id text, id text, type text, document text, processed_at integer, PRIMARY KEY(workspace_id,session_id,id)); CREATE TABLE managed_session_initial_events (workspace_id text, session_id text, sequence integer, document text);");
    const session = { id: "crash", environmentId: "env", archivedAt: null, status: "idle", updatedAt: "2026-11-10T00:00:00.000Z", outcomeEvaluations: [],
      agent: { openma: { harness: "acp-sandbox" } } } as never;
    const environment = { id: "env", archivedAt: null, config: { type: "cloud" } } as never;
    await client.prepare("INSERT INTO managed_sessions (workspace_id,id,revision,document) VALUES ('ws','crash',1,?)").bind(JSON.stringify(session)).run();
    const execution = { find: async () => {
      const row = (await client.prepare("SELECT revision,document FROM managed_sessions WHERE workspace_id = 'ws' AND id = 'crash'").first<{ revision: number; document: string }>())!;
      return { revision: row.revision, session: JSON.parse(row.document), environment };
    } };
    const source = new SqlSessionRuntimeHistorySource(client);
    const history = { loadSessionRuntimeHistory: async ({ sessionId }: { sessionId: string }) => {
      const found = await source.load({ workspaceId: "ws", sessionId });
      return found ? { type: "found" as const, ...found } : { type: "not_found" as const };
    } };
    let sequence = 0;
    const enqueuer = new EnvironmentWorkEnqueuerService({ workspaceId: "ws", store: new SqlEnvironmentWorkStore(client, cipher),
      credentials: { issue: async () => ({ type: "issued", secret: { sessionsToken: "test" } }), bindToClaim: async ({ secret }) => ({ secret }) },
      wakeup: { notifyRunStarted: async () => {} }, clock: { now: () => new Date("2026-11-10T00:00:00.000Z") }, ids: { nextEnvironmentWorkId: () => "crash-work-" + ++sequence } });
    const router = new EnvironmentAwareSessionEventDispatchRouter({ selfHostedWork: enqueuer,
      runtime: { sessionEventsAccepted: async () => { throw new Error("must never replay host execution"); } } });
    const store = new SqlSessionEventStore(client);
    const make = (crash: boolean) => new SessionEventsApplicationService({ workspaceId: "ws", store,
      sessions: { find: async () => session }, execution, stream: { async *subscribe() {} },
      dispatch: crash ? { sessionEventsAccepted: async () => { throw new Error("lost after append"); } } : router,
      schedulingRecovery: new SessionSchedulingRecoveryService({ workspaceId: "ws", execution, history, dispatch: router }),
      clock: { now: () => new Date("2026-11-10T00:00:00.000Z") }, ids: { nextEventId: () => "input", nextOutcomeId: () => "outcome" } });
    const command = { sessionId: "crash", idempotencyKey: "crash-key", events: [{ type: "user.message" as const, content: [] }] };
    await expect(make(true).sendSessionEvents(command)).rejects.toThrow("lost after append");
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'crash'").first()).toEqual({ n: 0 });
    await make(false).sendSessionEvents(command);
    await make(false).sendSessionEvents(command);
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'crash'").first()).toEqual({ n: 1 });
    const inputs = await store.list({ workspaceId: "ws", sessionId: "crash", order: "asc", limit: 100 });
    expect(inputs).toMatchObject([{ type: "user.message", processedAt: null }]);
    await store.markProcessed({ workspaceId: "ws", sessionId: "crash", eventIds: [inputs[0]!.id], processedAt: "2026-11-10T00:01:00.000Z", consumedByExecutionId: "unknown-effect" });
    await client.prepare("UPDATE managed_environment_work SET state = 'stopped' WHERE session_id = 'crash'").run();
    await make(false).sendSessionEvents(command);
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'crash'").first()).toEqual({ n: 1 });
  });

  it.each(["queued", "starting", "active", "stopping", "stopped"] as const)("concurrent clients preserve %s claims and ensure one consumer", async state => {
    const a = new SqlEnvironmentWorkStore(client, cipher);
    const b = new SqlEnvironmentWorkStore(new CfD1SqlClient(await mf.getD1Database("DB")), cipher);
    const sessionId = "session_" + state;
    await client.prepare("INSERT INTO managed_sessions (workspace_id,id,revision,document) VALUES ('ws', ?, 1, ?)")
      .bind(sessionId, JSON.stringify({ environmentId: "env", archivedAt: null })).run();
    const old = record("old_" + state, sessionId);
    old.work.state = state;
    old.claim = { workerId: "old-worker", generation: 3, claimedAt: old.work.createdAt };
    const original = await a.insert({ workspaceId: "ws", record: old });
    const results = await Promise.all([
      a.ensureSession({ workspaceId: "ws", record: record("a_" + state, sessionId) }),
      b.ensureSession({ workspaceId: "ws", record: record("b_" + state, sessionId) }),
    ]);
    expect(results[0].work.id).toBe(results[1].work.id);
    expect(results[0].work.id === old.work.id).toBe(["queued", "starting", "active"].includes(state));
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = ? AND state IN ('queued','starting','active')").bind(sessionId).first()).toEqual({ n: 1 });
    expect(await a.find({ workspaceId: "ws", environmentId: "env", workId: old.work.id })).toEqual(original);
  });

  it("does not schedule an input consumed without changing the Session revision", async () => {
    await client.prepare("INSERT INTO managed_sessions (workspace_id,id,revision,document) VALUES ('ws','consumption-race',1,?)")
      .bind(JSON.stringify({ environmentId: "env", archivedAt: null })).run();
    await client.prepare("INSERT INTO managed_session_events VALUES ('ws','consumption-race',NULL,'consumed','user.message',?,1)")
      .bind(JSON.stringify({ id: "consumed", type: "user.message", processedAt: "2026-11-10T00:00:00.000Z", source_position: { revision: 1, index: 0, consumed_by_execution_id: "old" } })).run();
    const store = new SqlEnvironmentWorkStore(client, cipher);
    await expect(store.ensureSession({ workspaceId: "ws", record: record("consumption-race-work", "consumption-race"),
      expectedSessionRevision: 1, recoveryEventIds: ["consumed"] })).rejects.toThrow("consum");
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'consumption-race'").first()).toEqual({ n: 0 });
  });

  it("rolls back when consumption wins after recovery reads but before its D1 transaction", async () => {
    await client.prepare("INSERT INTO managed_sessions (workspace_id,id,revision,document) VALUES ('ws','late-consumption',1,?)")
      .bind(JSON.stringify({ environmentId: "env", archivedAt: null })).run();
    await client.prepare("INSERT INTO managed_session_events VALUES ('ws','late-consumption',NULL,'late-input','user.message',?,1)")
      .bind(JSON.stringify({ id: "late-input", type: "user.message", processedAt: null, source_position: { revision: 1, index: 0 } })).run();
    const competing = new SqlSessionEventStore(client);
    const store = new SqlEnvironmentWorkStore({ prepare: sql => client.prepare(sql), exec: sql => client.exec(sql),
      batch: async statements => {
        await competing.markProcessed({ workspaceId: "ws", sessionId: "late-consumption", eventIds: ["late-input"],
          processedAt: "2026-11-10T00:01:00.000Z", consumedByExecutionId: "already-executed" });
        return client.batch(statements);
      },
    }, cipher);
    await expect(store.ensureSession({ workspaceId: "ws", record: record("late-work", "late-consumption"),
      expectedSessionRevision: 1, recoveryEventIds: ["late-input"] })).rejects.toThrow();
    expect(await client.prepare("SELECT revision FROM managed_sessions WHERE id = 'late-consumption'").first()).toEqual({ revision: 1 });
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'late-consumption'").first()).toEqual({ n: 0 });
    expect(await competing.list({ workspaceId: "ws", sessionId: "late-consumption", limit: 10, order: "asc" })).toMatchObject([{ processedAt: "2026-11-10T00:01:00.000Z" }]);
  });

  it("never refreshes a stale recovery snapshot to create Work", async () => {
    await client.prepare("INSERT INTO managed_sessions (workspace_id,id,revision,document) VALUES ('ws', 'snapshot', 2, ?)")
      .bind(JSON.stringify({ environmentId: "env", archivedAt: null })).run();
    const store = new SqlEnvironmentWorkStore(client, cipher);
    await expect(store.ensureSession({ workspaceId: "ws", record: record("snapshot-work", "snapshot"), expectedSessionRevision: 1 }))
      .rejects.toThrow("snapshot");
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'snapshot'").first()).toEqual({ n: 0 });
  });

  it("the shared enqueuer creates and reuses Work through D1", async () => {
    await client.prepare("INSERT INTO managed_sessions (workspace_id,id,revision,document) VALUES ('ws', 'enqueue', 1, ?)")
      .bind(JSON.stringify({ environmentId: "env", archivedAt: null })).run();
    let sequence = 0;
    const create = () => new EnvironmentWorkEnqueuerService({ workspaceId: "ws", store: new SqlEnvironmentWorkStore(client, cipher),
      credentials: { issue: async () => ({ type: "issued", secret: { sessionsToken: "test" } }), bindToClaim: async ({ secret }) => ({ secret }) },
      wakeup: { notifyRunStarted: async () => {} }, clock: { now: () => new Date("2026-11-10T00:00:00.000Z") },
      ids: { nextEnvironmentWorkId: () => "enqueue_" + ++sequence },
    });
    const input = { workspaceId: "ws", environment: { id: "env", archivedAt: null, config: { type: "self_hosted" } },
      session: { id: "enqueue", environmentId: "env", archivedAt: null, agent: {} } } as Parameters<EnvironmentWorkEnqueuerService["enqueue"]>[0];
    const [first, second] = await Promise.all([create().enqueue(input), create().enqueue(input)]);
    expect(first.type).toBe("queued");
    expect(second).toEqual(first);
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'enqueue'").first()).toEqual({ n: 1 });
  });

  it("a rejected final Session CAS cannot leave an orphan Work", async () => {
    const store = new SqlEnvironmentWorkStore(client, cipher);
    await client.prepare("INSERT INTO managed_sessions (workspace_id,id,revision,document) VALUES ('ws', 'cas-refused', 1, ?)")
      .bind(JSON.stringify({ environmentId: "env", archivedAt: null })).run();
    await client.prepare("CREATE TRIGGER refuse_revision BEFORE UPDATE ON managed_sessions WHEN OLD.id = 'cas-refused' AND NEW.revision > OLD.revision BEGIN SELECT RAISE(IGNORE); END").run();
    await expect(store.ensureSession({ workspaceId: "ws", record: record("cas-work", "cas-refused") })).rejects.toThrow();
    expect(await client.prepare("SELECT revision FROM managed_sessions WHERE id = 'cas-refused'").first()).toEqual({ revision: 1 });
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'cas-refused'").first()).toEqual({ n: 0 });
  });

  it("a failed insert rolls back the Session revision and all Work writes", async () => {
    const store = new SqlEnvironmentWorkStore(client, cipher);
    await client.prepare("INSERT INTO managed_sessions (workspace_id,id,revision,document) VALUES ('ws', 'failure', 1, ?)")
      .bind(JSON.stringify({ environmentId: "env", archivedAt: null })).run();
    await store.insert({ workspaceId: "ws", record: record("occupied", "unrelated") });
    await expect(store.ensureSession({ workspaceId: "ws", record: record("occupied", "failure") })).rejects.toThrow();
    expect(await client.prepare("SELECT revision FROM managed_sessions WHERE id = 'failure'").first()).toEqual({ revision: 1 });
    expect(await client.prepare("SELECT count(*) AS n FROM managed_environment_work WHERE session_id = 'failure'").first()).toEqual({ n: 0 });
  });
});
