import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient, type SqlStatement } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionStore } from "../src/coordination";

const scope = { workspaceId: "w", sessionId: "s" };
const now = "2026-11-05T00:00:00.000Z";
const message = (id: string) => ({ id, type: "user.message" as const,
  content: [{ type: "text" as const, text: id }], processedAt: null });
const claim = (ownerId: string) => ({ ...scope, ownerId, attemptId: ownerId, claimedAt: now, leaseTtlMs: 30_000 });

describe("atomic held input absorption", () => {
  let sql: SqlClient;
  let store: SqlSessionExecutionStore;
  beforeEach(async () => {
    sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSessionExecutionCoordinatorSchema(sql);
    await sql.exec(`CREATE TABLE managed_session_events (workspace_id TEXT, session_id TEXT,
      id TEXT, document TEXT, processed_at BIGINT, PRIMARY KEY (workspace_id, session_id, id))`);
    store = new SqlSessionExecutionStore(sql);
    await admit("held");
    await store.markHeldAfterExhausted({ ...scope, executionId: "held", heldAt: new Date(now) });
    await admit("next");
  });
  async function admit(id: string) {
    await store.admit({ execution: { ...scope, id, admittedAt: now, events: [message(id)] } });
    await sql.prepare("INSERT INTO managed_session_events (workspace_id, session_id, id, document) VALUES (?, ?, ?, ?)")
      .bind(scope.workspaceId, scope.sessionId, id, JSON.stringify(message(id))).run();
  }
  const find = (executionId: string) => store.find({ workspaceId: scope.workspaceId, executionId });
  async function heldDocument() {
    const row = await sql.prepare("SELECT document FROM managed_session_events WHERE id = 'held'").first<{ document: string }>();
    return JSON.parse(row!.document);
  }
  function interceptBatch(before: (statements: SqlStatement[]) => Promise<SqlStatement[]>) {
    return new SqlSessionExecutionStore({ prepare: query => sql.prepare(query), exec: query => sql.exec(query),
      batch: async statements => sql.batch(await before(statements)),
    });
  }

  it("preserves held inputs when a concurrent claim defeats the destination snapshot", async () => {
    let injected = false;
    const contender = interceptBatch(async statements => {
      if (!injected) {
        injected = true;
        await sql.prepare(`UPDATE managed_session_executions SET state = 'running', revision = revision + 1,
          owner_id = 'winner', attempt_id = 'winner', generation = 1, attempt_count = 1,
          claimed_at_ms = ?, lease_expires_at_ms = ? WHERE id = 'next'`)
          .bind(Date.parse(now), Date.parse(now) + 30_000).run();
      }
      return statements;
    });
    expect(await contender.claim(claim("loser"))).toEqual({ type: "empty" });
    expect(injected).toBe(true);
    expect(await find("held")).toMatchObject({ state: "queued", heldAfterExhaustedAt: now, events: [{ id: "held" }] });
    expect((await find("next"))!.events.map(event => event.id)).toEqual(["next"]);
    expect(await heldDocument()).toHaveProperty("heldAfterExhausted", true);
    await sql.prepare("UPDATE managed_session_executions SET state = 'completed', revision = revision + 1 WHERE id = 'next'").run();
    await admit("later");
    const recovered = await new SqlSessionExecutionStore(sql).claim(claim("restart"));
    expect(recovered.type === "claimed" && recovered.execution.events.map(event => event.id)).toEqual(["held", "later"]);
  });

  it("retries when a held source changes instead of completing an obsolete snapshot", async () => {
    let attempts = 0;
    const contender = interceptBatch(async statements => {
      if (++attempts === 1) {
        await sql.prepare("UPDATE managed_session_executions SET events_json = ?, revision = revision + 1 WHERE id = 'held'")
          .bind(JSON.stringify([message("held"), message("concurrent-input")])).run();
      }
      return statements;
    });
    const result = await contender.claim(claim("worker"));
    expect(attempts).toBe(2);
    expect(result.type === "claimed" && result.execution.events.map(event => event.id))
      .toEqual(["held", "concurrent-input", "next"]);
    expect(await find("held")).toMatchObject({ state: "completed", heldAfterExhaustedAt: null });
  });

  it("lets competing absorbers transfer the same held input only once", async () => {
    let release!: () => void;
    const bothSelected = new Promise<void>(resolve => { release = resolve; });
    let arrived = 0;
    const before = async (statements: SqlStatement[]) => {
      if (++arrived <= 2) {
        if (arrived === 2) release();
        await bothSelected;
      }
      return statements;
    };
    const results = await Promise.all([interceptBatch(before).claim(claim("a")), interceptBatch(before).claim(claim("b"))]);
    expect(results.filter(result => result.type === "claimed")).toHaveLength(1);
    expect((await find("next"))!.events.map(event => event.id)).toEqual(["held", "next"]);
    expect(await find("held")).toMatchObject({ state: "completed", heldAfterExhaustedAt: null });
    expect(await heldDocument()).not.toHaveProperty("heldAfterExhausted");
  });

  it.each([6, 7])("rolls back a transaction failure at statement %s and recovers without duplicate input", async failureIndex => {
    // With one source these are the boundaries after merge and after source
    // completion. A real constraint failure aborts the entire SQL transaction.
    const broken = interceptBatch(async statements => [
      ...statements.slice(0, failureIndex),
      sql.prepare("INSERT INTO managed_session_events (workspace_id, session_id, id, document) VALUES (?, ?, 'held', '{}')")
        .bind(scope.workspaceId, scope.sessionId),
      ...statements.slice(failureIndex),
    ]);
    await expect(broken.claim(claim("crashed"))).rejects.toThrow();
    expect((await find("next"))!.events.map(event => event.id)).toEqual(["next"]);
    expect(await find("held")).toMatchObject({ state: "queued", heldAfterExhaustedAt: now });
    expect(await heldDocument()).toHaveProperty("heldAfterExhausted", true);
    const recovered = await new SqlSessionExecutionStore(sql).claim(claim("restart"));
    expect(recovered.type === "claimed" && recovered.execution.events.map(event => event.id)).toEqual(["held", "next"]);
    expect(await heldDocument()).not.toHaveProperty("heldAfterExhausted");
  });

  it("leaves newly held rows outside the captured transfer for the next admission", async () => {
    let injected = false;
    const contender = interceptBatch(async statements => {
      if (!injected) {
        injected = true;
        await admit("late-held");
        await store.markHeldAfterExhausted({ ...scope, executionId: "late-held", heldAt: new Date(now) });
      }
      return statements;
    });
    const result = await contender.claim(claim("worker"));
    expect(result.type === "claimed" && result.execution.events.map(event => event.id)).toEqual(["held", "next"]);
    expect(await find("late-held")).toMatchObject({ state: "queued", heldAfterExhaustedAt: now, events: [{ id: "late-held" }] });
  });
});
