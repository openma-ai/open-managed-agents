import { beforeEach, describe, expect, it } from "vitest";
import type { SentSessionEvent, Session } from "@open-managed-agents/domain/sessions";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { takeQueuedSteeringInputs } from "../../session-runtime-contract/src/coordination";
import { decodeSessionEventDocument } from "../../session-runtime-contract/src/history";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionStore } from "../../session-runtime-sql/src/coordination";
import { SqlSessionStore } from "../../session-store-sql/src/index";
import { SqlSessionEventStore } from "../src/index";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 4, 0, 0, seconds)).toISOString();
const scope = { workspaceId: "workspace", sessionId: "session" };
const message = (id: string, sessionThreadId?: string): SentSessionEvent => ({
  id, type: "user.message", content: [{ type: "text", text: id }], processedAt: null,
  ...(sessionThreadId ? { sessionThreadId } : {}),
});
const session = (seconds: number): Session => ({
  id: scope.sessionId, environmentId: "env", status: "running", updatedAt: at(seconds),
  createdAt: at(seconds), archivedAt: null, budget: null, metadata: {}, outcomeEvaluations: [],
  resources: [], stats: {}, title: null, usage: {}, vaultIds: [],
  agent: { id: "agent", version: 1, name: "test", description: null, mcpServers: [],
    model: { id: "test" }, multiagent: null, skills: [], system: null, tools: [] },
});

describe("transactional outbox admission FIFO", () => {
  let sql: SqlClient;
  let events: SqlSessionEventStore;
  let executions: SqlSessionExecutionStore;
  beforeEach(async () => {
    sql = await createBetterSqlite3SqlClient(":memory:");
    await sql.exec(`CREATE TABLE managed_sessions (
      workspace_id TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT, updated_at INTEGER, agent_id TEXT, agent_version INTEGER, environment_id TEXT,
      deployment_id TEXT, created_at INTEGER, archived_at INTEGER, PRIMARY KEY (workspace_id, id));
      CREATE TABLE managed_session_events (workspace_id TEXT, session_id TEXT, thread_id TEXT,
        id TEXT, type TEXT, document TEXT, processed_at INTEGER, PRIMARY KEY (workspace_id, session_id, id));
      CREATE TABLE managed_session_initial_events (workspace_id TEXT, session_id TEXT, sequence INTEGER,
        document TEXT, PRIMARY KEY (workspace_id, session_id, sequence));`);
    await sql.prepare("INSERT INTO managed_sessions (workspace_id, id, document, revision) VALUES (?, ?, '{}', 1)")
      .bind(scope.workspaceId, scope.sessionId).run();
    await ensureSessionExecutionCoordinatorSchema(sql);
    events = new SqlSessionEventStore(sql, { executionOutbox: true });
    executions = new SqlSessionExecutionStore(sql);
  });
  const append = (inputs: SentSessionEvent[], expectedRevision: number, seconds: number) => events.append({
    ...scope, expectedRevision, events: inputs, nextSession: session(seconds),
  });
  async function orderedRows() {
    return (await sql.prepare("SELECT id, admission_sequence FROM managed_session_executions ORDER BY admission_sequence").all()).results;
  }
  async function counter() {
    return sql.prepare("SELECT last_sequence FROM managed_session_admission_counters WHERE workspace_id = ? AND session_id = ?")
      .bind(scope.workspaceId, scope.sessionId).first();
  }

  it("shares the admission counter with standalone admission and preserves batch first-appearance order", async () => {
    expect((await append([message("z-first"), message("a-child", "child"), message("m-same-batch")], 1, 10)).type).toBe("appended");
    await executions.admit({ execution: { ...scope, id: "b-direct", admittedAt: at(9), events: [message("b-direct")] } });
    expect((await append([message("a-last")], 2, 8)).type).toBe("appended");
    expect(await orderedRows()).toEqual([
      { id: "z-first", admission_sequence: 1 }, { id: "a-child", admission_sequence: 2 },
      { id: "b-direct", admission_sequence: 3 }, { id: "a-last", admission_sequence: 4 },
    ]);
    const first = await executions.find({ workspaceId: scope.workspaceId, executionId: "z-first" });
    expect(first!.events.map(event => event.id)).toEqual(["z-first", "m-same-batch"]);
    const document = await sql.prepare("SELECT document FROM managed_session_events WHERE id = 'm-same-batch'").first<{ document: string }>();
    expect(decodeSessionEventDocument(document!.document)).toMatchObject({ position: { revision: 2, index: 2 }, executionId: "z-first" });
    for (const id of ["z-first", "b-direct", "a-last"]) {
      const claim = await executions.claim({ ...scope, laneId: "sthr_primary", ownerId: "worker", attemptId: id, claimedAt: at(20), leaseTtlMs: 30_000 });
      expect(claim).toMatchObject({ type: "claimed", execution: { id } });
      if (claim.type !== "claimed") throw new Error("expected claim");
      await executions.settle({ fence: claim.fence, settledAt: at(21), outcome: "completed" });
    }
  });

  it("leaves no phantom admission or counter advance when revision CAS loses, including concurrent writers", async () => {
    const results = await Promise.all([
      append([message("winner-or-loser-a")], 1, 10), append([message("winner-or-loser-b")], 1, 9),
    ]);
    expect(results.map(result => result.type).sort()).toEqual(["appended", "revision_conflict"]);
    const rows = await orderedRows();
    expect(rows).toHaveLength(1);
    expect(await counter()).toEqual({ last_sequence: 1 });
    const winner = results[0]!.type === "appended" ? "winner-or-loser-a" : "winner-or-loser-b";
    expect(rows).toEqual([{ id: winner, admission_sequence: 1 }]);
    expect((await sql.prepare("SELECT id FROM managed_session_events").all()).results).toEqual([{ id: winner }]);
    // A client replay with the latest revision cannot move or duplicate its
    // original execution. A harmless sequence gap is allowed.
    expect((await append([message(winner)], 2, 8)).type).toBe("appended");
    expect(await orderedRows()).toEqual([{ id: winner, admission_sequence: 1 }]);
    expect((await append([message("next")], 3, 7)).type).toBe("appended");
    expect(await orderedRows()).toEqual([{ id: winner, admission_sequence: 1 }, { id: "next", admission_sequence: 3 }]);
  });

  it("rolls back events, outbox, revision and sequence allocation if any statement fails", async () => {
    events = new SqlSessionEventStore({ prepare: query => sql.prepare(query), exec: query => sql.exec(query),
      batch: statements => sql.batch([...statements,
        sql.prepare("INSERT INTO managed_sessions (workspace_id, id, document, revision) VALUES (?, ?, '{}', 1)")
          .bind(scope.workspaceId, scope.sessionId),
      ]),
    }, { executionOutbox: true });
    await expect(append([message("rollback")], 1, 10)).rejects.toThrow();
    expect(await orderedRows()).toEqual([]);
    expect(await counter()).toBeNull();
    expect((await sql.prepare("SELECT id FROM managed_session_events").all()).results).toEqual([]);
    expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({ revision: 1 });
  });

  it("delivers same-lane queued steering in admission order despite equal and backward clocks", async () => {
    await append([message("running")], 1, 10);
    const claim = await executions.claim({ ...scope, ownerId: "worker", attemptId: "running", claimedAt: at(11), leaseTtlMs: 30_000 });
    if (claim.type !== "claimed") throw new Error("expected claim");
    await append([message("z-first")], 2, 12);
    await append([message("m-second")], 3, 12);
    await append([message("a-third")], 4, 9);
    const steering = await takeQueuedSteeringInputs(executions, {
      ...scope, laneId: "sthr_primary", consumer: claim.fence, steeredAt: at(20),
    });
    expect(steering.map(event => event.id)).toEqual(["z-first", "m-second", "a-third"]);
  });

  it("keeps creation-bootstrap sequence zero ahead of later outbox admissions", async () => {
    await new SqlSessionStore(sql, { seal: async value => value }, { executionOutbox: true }).insert({
      workspaceId: scope.workspaceId, resourceSecrets: [],
      session: { ...session(10), id: "bootstrap", status: "idle" },
      initialEvents: [{ type: "user.message", content: [{ type: "text", text: "first" }] }],
    });
    expect((await events.append({ workspaceId: scope.workspaceId, sessionId: "bootstrap", expectedRevision: 1,
      events: [message("a-later")], nextSession: { ...session(1), id: "bootstrap" },
    })).type).toBe("appended");
    expect(await orderedRows()).toEqual([{ id: "bootstrap_bootstrap:0", admission_sequence: 0 }, { id: "a-later", admission_sequence: 1 }]);
    const claim = await executions.claim({ workspaceId: scope.workspaceId, sessionId: "bootstrap", ownerId: "worker",
      attemptId: "bootstrap-first", claimedAt: at(20), leaseTtlMs: 30_000 });
    expect(claim).toMatchObject({ type: "claimed", execution: { id: "bootstrap_bootstrap:0" } });
  });
});
