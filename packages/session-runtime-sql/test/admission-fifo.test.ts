import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionStore } from "../src/coordination";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 4, 0, 0, seconds)).toISOString();
const scope = { workspaceId: "workspace", sessionId: "session" };
const input = (id: string, seconds: number) => ({ execution: {
  ...scope, id, admittedAt: at(seconds),
  events: [{ id, type: "user.message" as const, content: [{ type: "text" as const, text: id }], processedAt: null }],
} });

describe("durable admission FIFO", () => {
  let sql: SqlClient;
  let store: SqlSessionExecutionStore;
  const directories: string[] = [];
  beforeEach(async () => {
    sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSessionExecutionCoordinatorSchema(sql);
    store = new SqlSessionExecutionStore(sql);
  });
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  async function drain(expected: string[]) {
    for (const [index, id] of expected.entries()) {
      const claim = await store.claim({ ...scope, ownerId: "worker", attemptId: `attempt-${index}`, claimedAt: at(20), leaseTtlMs: 30_000 });
      expect(claim).toMatchObject({ type: "claimed", execution: { id } });
      if (claim.type !== "claimed") throw new Error("expected claim");
      await store.settle({ fence: claim.fence, settledAt: at(21), outcome: "completed" });
    }
  }

  it.each([
    { name: "equal clocks and reversed IDs", seconds: [10, 10, 10] },
    { name: "a clock which moves backward", seconds: [10, 9, 8] },
  ])("claims actual admission order with $name", async ({ seconds }) => {
    const ids = ["z-first", "m-second", "a-third"];
    for (const [index, id] of ids.entries()) await store.admit(input(id, seconds[index]!));
    expect((await store.listQueued({ ...scope, laneId: "sthr_primary" })).map(row => row.id)).toEqual(ids);
    expect((await store.listActive(scope)).map(row => row.id)).toEqual(ids);
    // Deadline semantics still use real time, not the FIFO sequence.
    expect((await store.find({ workspaceId: scope.workspaceId, executionId: ids[2]! }))!.deadlineAt)
      .toBe(new Date(Date.parse(at(seconds[2]!)) + 3_600_000).toISOString());
    await drain(ids);
  });

  it("keeps sequence allocation durable across connections, restarts and duplicate admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openma-admission-fifo-"));
    directories.push(directory);
    const path = join(directory, "shared.sqlite");
    sql = await createBetterSqlite3SqlClient(path);
    await ensureSessionExecutionCoordinatorSchema(sql);
    const first = new SqlSessionExecutionStore(sql);
    const second = new SqlSessionExecutionStore(await createBetterSqlite3SqlClient(path));
    expect((await first.admit(input("z-first", 10))).type).toBe("admitted");
    expect((await second.admit(input("z-first", 10))).type).toBe("replayed");
    expect((await second.admit(input("a-second", 9))).type).toBe("admitted");
    const rows = await sql.prepare("SELECT id, admission_sequence FROM managed_session_executions ORDER BY admission_sequence").all();
    expect(rows.results).toEqual([{ id: "z-first", admission_sequence: 1 }, { id: "a-second", admission_sequence: 3 }]);
    store = new SqlSessionExecutionStore(await createBetterSqlite3SqlClient(path));
    await drain(["z-first", "a-second"]);
  });

  it("rolls back the counter and admission together on a transaction failure", async () => {
    const broken = new SqlSessionExecutionStore({
      prepare: query => sql.prepare(query), exec: query => sql.exec(query),
      batch: statements => sql.batch([...statements,
        sql.prepare("INSERT INTO managed_session_admission_counters (workspace_id, session_id) VALUES (?, ?)").bind(scope.workspaceId, scope.sessionId),
      ]),
    });
    await expect(broken.admit(input("must-rollback", 10))).rejects.toThrow();
    expect(await store.find({ workspaceId: scope.workspaceId, executionId: "must-rollback" })).toBeNull();
    expect((await sql.prepare("SELECT * FROM managed_session_admission_counters").all()).results).toEqual([]);
    await store.admit(input("committed", 9));
    expect(await sql.prepare("SELECT admission_sequence FROM managed_session_executions").first()).toEqual({ admission_sequence: 1 });
  });

  it("upgrades historical rows as sequence zero before new work without inventing their past order", async () => {
    await store.admit(input("z-old", 10));
    await store.admit(input("a-old", 10));
    await sql.exec("DROP INDEX managed_session_executions_admission_idx");
    await sql.exec("ALTER TABLE managed_session_executions DROP COLUMN admission_sequence");
    await sql.exec("DROP TABLE managed_session_admission_counters");
    await ensureSessionExecutionCoordinatorSchema(sql);
    await store.admit(input("new-with-earlier-clock", 1));
    expect((await sql.prepare("SELECT id, admission_sequence FROM managed_session_executions ORDER BY admission_sequence, admitted_at_ms, id").all()).results)
      .toEqual([{ id: "a-old", admission_sequence: 0 }, { id: "z-old", admission_sequence: 0 }, { id: "new-with-earlier-clock", admission_sequence: 1 }]);
    await drain(["a-old", "z-old", "new-with-earlier-clock"]);
  });

  it("retains held input admission order when a later execution absorbs them", async () => {
    await sql.exec("CREATE TABLE managed_session_events (workspace_id TEXT, session_id TEXT, id TEXT, document TEXT, processed_at BIGINT)");
    for (const [id, seconds] of [["z-held", 10], ["a-held", 9]] as const) {
      await store.admit(input(id, seconds));
      await store.markHeldAfterExhausted({ ...scope, executionId: id, heldAt: new Date(at(11)) });
    }
    await store.admit(input("new", 8));
    const claim = await store.claim({ ...scope, ownerId: "worker", attemptId: "absorb", claimedAt: at(20), leaseTtlMs: 30_000 });
    expect(claim.type === "claimed" && claim.execution.events.map(event => event.id)).toEqual(["z-held", "a-held", "new"]);
  });
});
