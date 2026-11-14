import { createDispatchedManagedEnvironmentWorker } from "../../managed-runtime-host/src/dispatched-environment-worker";
import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  EnvironmentWorkRecord,
  StoredEnvironmentWork,
} from "@open-managed-agents/environment-work-store";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  SqlEnvironmentWorkStore,
  type EnvironmentWorkSecretCipher,
} from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_environment_work (
  workspace_id text NOT NULL,
  environment_id text NOT NULL,
  id text NOT NULL,
  session_id text,
  document text NOT NULL,
  sealed_secret text NOT NULL,
  claim_at integer,
  claim_worker_id text,
  claim_generation integer NOT NULL DEFAULT 0,
  heartbeat_ttl_seconds integer NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  created_at integer NOT NULL,
  runtime_publication_json text,
  sandbox_token_hashes text,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_environment_work_queue
  ON managed_environment_work (workspace_id, environment_id, state, claim_at, created_at, id);
CREATE TABLE managed_environment_work_workers (
  workspace_id text NOT NULL,
  environment_id text NOT NULL,
  worker_id text NOT NULL,
  last_polled_at integer NOT NULL,
  PRIMARY KEY (workspace_id, environment_id, worker_id)
);
`;

const cipher: EnvironmentWorkSecretCipher = {
  seal: async ({ plaintext }) => ({ ciphertext: `sealed:${plaintext}` }),
  open: async ({ ciphertext }) => ({ plaintext: ciphertext.slice(7) }),
};

const record: EnvironmentWorkRecord = {
  work: {
    id: "work_01",
    acknowledgedAt: null,
    createdAt: "2026-08-26T09:10:00.000Z",
    data: { type: "session", id: "session_01" },
    environmentId: "env_self_01",
    latestHeartbeatAt: null,
    metadata: { shard: "a" },
    startedAt: null,
    state: "queued",
    stopRequestedAt: null,
    stoppedAt: null,
  },
  secret: {
    sessionsToken: "sk-ant-req-session-token",
    apiBaseUrl: "https://openma.test",
  },
  claim: null,
  heartbeatTtlSeconds: 90,
};

describe("SqlEnvironmentWorkStore atomic Session ensure", () => {
  it("fails closed for a missing or archived Session and rolls back an ambiguous consumer set", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await sql.exec(SCHEMA_SQL + "CREATE TABLE managed_sessions (workspace_id text, id text, revision integer, document text, PRIMARY KEY(workspace_id,id));");
    const store = new SqlEnvironmentWorkStore(sql, cipher);
    const input = { workspaceId: "workspace_01", record };
    await expect(store.ensureSession(input)).rejects.toThrow("Session not found");
    await sql.prepare("INSERT INTO managed_sessions VALUES (?, ?, 1, ?)")
      .bind(input.workspaceId, "session_01", JSON.stringify({ environmentId: record.work.environmentId, archivedAt: "2026-11-10T00:00:00.000Z" })).run();
    await expect(store.ensureSession(input)).rejects.toThrow("cannot accept Work");
    expect(await store.list({ workspaceId: input.workspaceId, environmentId: record.work.environmentId, limit: 10 })).toEqual([]);
    await sql.prepare("UPDATE managed_sessions SET document = ?").bind(JSON.stringify({ environmentId: record.work.environmentId, archivedAt: null })).run();
    await store.insert(input);
    await store.insert({ ...input, record: { ...record, work: { ...record.work, id: "duplicate" } } });
    await expect(store.ensureSession({ ...input, record: { ...record, work: { ...record.work, id: "candidate" } } })).rejects.toThrow("ambiguous");
    expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({ revision: 1 });
    expect(await store.list({ workspaceId: input.workspaceId, environmentId: record.work.environmentId, limit: 10 })).toHaveLength(2);
  });

  it.each(["queued", "starting", "active", "stopping", "stopped"] as const)("two connections reuse only consumable Work (%s) without touching the old claim", async state => {
    const base = join(process.cwd(), ".test-artifacts");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "work-ensure-"));
    try {
      const left = await createBetterSqlite3SqlClient(join(directory, "work.db"));
      const right = await createBetterSqlite3SqlClient(join(directory, "work.db"));
      await left.exec(SCHEMA_SQL +         "CREATE TABLE managed_sessions (workspace_id text, id text, revision integer, document text, PRIMARY KEY(workspace_id,id));");
      for (const workspaceId of ["workspace_01", "workspace_other"]) await left.prepare("INSERT INTO managed_sessions VALUES (?, ?, 1, ?)")
        .bind(workspaceId, "session_01", JSON.stringify({ environmentId: record.work.environmentId, archivedAt: null })).run();
      const a = new SqlEnvironmentWorkStore(left, cipher);
      const b = new SqlEnvironmentWorkStore(right, cipher);
      const original = await a.insert({ workspaceId: "workspace_01", record: {
        ...record, work: { ...record.work, state }, claim: { claimedAt: record.work.createdAt, workerId: "old", generation: 7 },
      } });
      const input = (id: string) => ({ workspaceId: "workspace_01", record: { ...record, work: { ...record.work, id } } });
      const [first, second] = await Promise.all([a.ensureSession!(input("new_a")), b.ensureSession!(input("new_b"))]);
      expect(first.work.id).toBe(second.work.id);
      const reusable = state === "queued" || state === "starting" || state === "active";
      expect(first.work.id === record.work.id).toBe(reusable);
      expect(await a.list({ workspaceId: "workspace_01", environmentId: record.work.environmentId, limit: 10 })).toHaveLength(reusable ? 1 : 2);
      expect(await a.find({ workspaceId: "workspace_01", environmentId: record.work.environmentId, workId: record.work.id })).toEqual(original);
      const other = await b.ensureSession!({ ...input("other"), workspaceId: "workspace_other" });
      expect(other.work.id).toBe("other");
      if (!reusable) {
        await a.replace({ workspaceId: "workspace_01", environmentId: record.work.environmentId, workId: original.work.id,
          expectedRevision: original.revision, next: { ...original, work: { ...original.work, state: "stopped" }, claim: null } });
        expect(await b.find({ workspaceId: "workspace_01", environmentId: record.work.environmentId, workId: first.work.id })).toEqual(first);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("SqlEnvironmentWorkStore", () => {
  let client: SqlClient;
  let persistence: SqlEnvironmentWorkStore;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    persistence = new SqlEnvironmentWorkStore(client, cipher);
  });

  it("stores a complete work record with its credential encrypted at rest", async () => {
    await expect(
      persistence.insert({ workspaceId: "workspace_01", record }),
    ).resolves.toEqual({ ...record, revision: 1 });

    const row = await client
      .prepare(
        `SELECT document, sealed_secret
           FROM managed_environment_work
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind("workspace_01", "work_01")
      .first<{ document: string; sealed_secret: string }>();
    expect(row?.document).not.toContain("sk-ant-req-session-token");
    expect(row?.sealed_secret).toContain("sealed:");

    await expect(
      persistence.find({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        workId: "work_01",
      }),
    ).resolves.toEqual({ ...record, revision: 1 });
    await expect(
      persistence.findActiveSession({
        workspaceId: "workspace_01",
        sessionId: "session_01",
      }),
    ).resolves.toEqual({ ...record, revision: 1 });
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        limit: 10,
      }),
    ).resolves.toEqual([{ ...record, revision: 1 }]);
  });

  it("claims one queued item atomically and reports delivery/worker statistics", async () => {
    await persistence.insert({ workspaceId: "workspace_01", record });

    const claimed = await persistence.claimAvailable({
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      claimedAt: "2026-08-26T09:20:00.000Z",
      reclaimBefore: "2026-08-26T09:19:55.000Z",
      workerId: "worker_01",
      heartbeatTtlSeconds: 90,
    });
    expect(claimed).toEqual({
      type: "claimed",
      record: {
        ...record,
        claim: {
          claimedAt: "2026-08-26T09:20:00.000Z",
          workerId: "worker_01",
          generation: 1,
        },
        revision: 2,
      },
    });
    await expect(
      persistence.claimAvailable({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        claimedAt: "2026-08-26T09:20:01.000Z",
        reclaimBefore: "2026-08-26T09:19:56.000Z",
        workerId: "worker_01",
        heartbeatTtlSeconds: 90,
      }),
    ).resolves.toEqual({ type: "empty" });
    await expect(
      persistence.queueStats({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        workerActiveSince: "2026-08-26T09:19:30.000Z",
      }),
    ).resolves.toEqual({
      depth: 0,
      oldestQueuedAt: "2026-08-26T09:10:00.000Z",
      pending: 1,
      workersPolling: 1,
    });
  });

  it("replaces under CAS and reports the actual conflicting revision", async () => {
    const inserted = await persistence.insert({
      workspaceId: "workspace_01",
      record,
    });
    const next: EnvironmentWorkRecord = {
      ...record,
      work: { ...record.work, metadata: { shard: "b" } },
    };
    const replaced = await persistence.replace({
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      workId: "work_01",
      expectedRevision: inserted.revision,
      next,
    });
    expect(replaced).toEqual({
      type: "replaced",
      record: { ...next, revision: 2 },
    });
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        workId: "work_01",
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it.each([
    {
      state: "starting" as const,
      acknowledgedAt: "2026-08-26T09:20:00.000Z",
      latestHeartbeatAt: null,
      startedAt: null,
    },
    {
      state: "active" as const,
      acknowledgedAt: "2026-08-26T09:19:00.000Z",
      latestHeartbeatAt: "2026-08-26T09:20:00.000Z",
      startedAt: "2026-08-26T09:19:01.000Z",
    },
  ])("atomically requeues an expired $state lease for one replacement worker", async (lifecycle) => {
    const expired: EnvironmentWorkRecord = {
      ...record,
      work: { ...record.work, ...lifecycle },
      claim: {
        claimedAt: "2026-08-26T09:20:00.000Z",
        workerId: "worker_dead",
        generation: 1,
      },
      heartbeatTtlSeconds: 30,
    };
    await persistence.insert({ workspaceId: "workspace_01", record: expired });

    const [first, second] = await Promise.all([
      persistence.claimAvailable({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        claimedAt: "2026-08-26T09:20:30.001Z",
        reclaimBefore: "2026-08-26T09:20:25.001Z",
        workerId: "worker_replacement_a",
        heartbeatTtlSeconds: 90,
      }),
      persistence.claimAvailable({
        workspaceId: "workspace_01",
        environmentId: "env_self_01",
        claimedAt: "2026-08-26T09:20:30.001Z",
        reclaimBefore: "2026-08-26T09:20:25.001Z",
        workerId: "worker_replacement_b",
        heartbeatTtlSeconds: 90,
      }),
    ]);

    expect([first.type, second.type].sort()).toEqual(["claimed", "empty"]);
    const winner = first.type === "claimed" ? first.record : second.type === "claimed" ? second.record : null;
    expect(winner).toMatchObject({
      work: {
        acknowledgedAt: null,
        latestHeartbeatAt: null,
        startedAt: null,
        state: "queued",
      },
      claim: {
        claimedAt: "2026-08-26T09:20:30.001Z",
        generation: 2,
      },
      heartbeatTtlSeconds: 90,
      revision: 2,
    });
    await expect(persistence.find({
      workspaceId: "workspace_01",
      environmentId: "env_self_01",
      workId: "work_01",
    })).resolves.toMatchObject({
      work: { state: "queued", latestHeartbeatAt: null },
      revision: 2,
    });
  });
});

// Minimal scheduler reproduction: real SQL selection + production drain, no
// provider substitute is claimed as live-provider acceptance.
it("does not starve newer Work behind a repeatedly rejected reservation across 22 minutes", async () => {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec(SCHEMA_SQL);
  const store = new SqlEnvironmentWorkStore(sql, cipher);
  const workspaceId = "diagnostic-workspace";
  const environmentId = record.work.environmentId;
  await store.insert({ workspaceId, record });
  await store.insert({ workspaceId, record: { ...record, work: { ...record.work, id: "newer-work", data: { type: "session", id: "newer-session" }, createdAt: "2026-08-26T09:10:01.000Z" } } });
  let now = Date.parse("2026-08-26T09:11:00.000Z");
  const dispatched: string[] = [];
  const worker = createDispatchedManagedEnvironmentWorker({
    environmentId, workspaceId, environmentKey: "fixture-only", workerId: "diagnostic-worker", maxWorkItemsPerDrain: 8,
    client: { baseURL: "https://fixture.invalid", beta: { webhooks: { unwrap: () => ({ type: "event", id: "diagnostic-wake", data: { type: "session.status_run_started", workspace_id: workspaceId } }) } },
      withOptions: () => ({ beta: { environments: { work: {
        async poll() {
          const result = await store.claimAvailable({ workspaceId, environmentId, claimedAt: new Date(now).toISOString(), reclaimBefore: new Date(now - 5000).toISOString(), workerId: "diagnostic-worker", heartbeatTtlSeconds: 90 });
          if (result.type === "empty") return null;
          return { id: result.record.work.id, environment_id: environmentId, data: result.record.work.data, secret: "fixture-only" } as never;
        }, async stop() {} } } } }) },
    dispatch: { descriptor: () => ({ provider: "diagnostic", version: "1", strategy: "poll_unacked_then_dispatch" }), async dispatch({ work }) { dispatched.push(work.id); if (work.id === record.work.id) throw new Error("provider dispatch rejected"); } },
  });
  for (let minute = 0; minute <= 22; minute++) {
    const pending: Promise<void>[] = [];
    expect(worker.handleWebhook({ body: "fixture", headers: {}, waitUntil: p => pending.push(p) }).type).toBe("triggered");
    await Promise.all(pending);
    now += 60000;
  }
  expect(dispatched[0]).toBe(record.work.id);
  expect(dispatched[1]).toBe("newer-work");
  expect(dispatched.filter(id => id === record.work.id).length).toBeGreaterThan(1);
  const newer = await store.find({ workspaceId, environmentId, workId: "newer-work" });
  expect(newer?.claim?.generation).toBeGreaterThan(0);
  expect(newer?.work.state).toBe("queued");
});
