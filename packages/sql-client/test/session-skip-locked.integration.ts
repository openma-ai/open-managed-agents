// S1-S5: these tests REQUIRE real, task-owned containers. Missing Docker is a
// prerequisite failure (Blocked), never an opt-in skip or mocked acceptance.
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import mysql from "mysql2/promise";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgresSqlClient } from "../src/adapters/postgres";
import { Mysql2SqlClient } from "../src/adapters/mysql2";
import type { SqlClient, SqlStatement, SqlTransaction } from "../src/ports";
import { sessionExecutionStoreConformance } from "../../session-runtime-contract/test/execution-store-conformance";
import { SqlSessionExecutionCoordinator, sessionExecutionCoordinatorSqlSchema } from "../../session-runtime-sql/src/coordination";

// Optional fixture is created by the handoff's isolated-local-db.py launcher.
// Never consume a developer/owner DATABASE_URL or an arbitrary remote server.
const fixturePath = process.env.PR545_SKIP_LOCKED_FIXTURE;
const localFixture = fixturePath ? (() => {
  const path = realpathSync(fixturePath);
  if (!path.startsWith("/tmp/pr545-isolated-db-")) throw new Error("Expected task-owned local fixture");
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (fixture.owner !== "pr545-skip-locked") throw new Error("Unknown fixture owner");
  for (const engine of ["postgres", "mysql"]) {
    const url = new URL(fixture[engine]);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/pr545_skiplocked") throw new Error("Not an isolated task database");
  }
  return fixture as { postgres: string; mysql: string };
})() : undefined;

const evidence = (type: string, data: unknown) => {
  const row = JSON.stringify({ type, data });
  console.log(row);
  if (fixturePath) appendFileSync(join(dirname(realpathSync(fixturePath)), "evidence.jsonl"), row + "\n");
};
afterEach(() => evidence("assertions", { test: expect.getState().currentTestName, count: expect.getState().assertionCalls }));

for (const backend of ["postgres", "mysql"] as const) describe(`real ${backend} session claims`, () => {
  let container: { stop(): Promise<unknown> } | undefined;
  let sql: SqlClient;
  let loseCommitAcknowledgement = false;
  let close: (() => Promise<unknown>) | undefined;
  const trace: Array<{ text: string; connection: string; transaction?: string; isolation?: string }> = [];
  const now = new Date("2026-11-12T00:00:00Z");
  beforeAll(async () => {
    if (backend === "postgres") {
      const pg = localFixture ? undefined : await new PostgreSqlContainer("postgres:17-alpine").start(); container = pg;
      const pool = postgres(localFixture?.postgres ?? pg!.getConnectionUri(), { max: 8 }); close = () => pool.end();
      sql = new PostgresSqlClient({
        unsafe: (text, params) => pool.unsafe(text, params as never) as never,
        begin: async (body) => {
          let claimed = false;
          const result = await pool.begin(async tx => body({
          unsafe: async (text, params) => {
            if (text.includes("attempt_count = attempt_count + 1")) claimed = true;
            if (!text.startsWith("SET TRANSACTION")) {
              const [identity] = await tx.unsafe("SELECT pg_backend_pid() AS connection, txid_current() AS transaction");
              trace.push({ text, connection: String(identity.connection), transaction: String(identity.transaction) });
            }
            return await tx.unsafe(text, params as never) as never;
          },
          begin: async () => { throw new Error("nested transaction"); },
          })) as never;
          if (loseCommitAcknowledgement && claimed) { loseCommitAcknowledgement = false; throw new Error("lost COMMIT acknowledgement"); }
          return result;
        },
      });
    } else {
      const my = localFixture ? undefined : await new MySqlContainer("mysql:8.4").start(); container = my;
      const pool = mysql.createPool({ uri: localFixture?.mysql ?? my!.getConnectionUri().replace(/\/\/[^@]*@/, `//root:${my!.getRootPassword()}@`), connectionLimit: 8, flags: ["-FOUND_ROWS"], multipleStatements: true });
      close = () => pool.end();
      await pool.query("UPDATE performance_schema.setup_instruments SET ENABLED='YES', TIMED='YES' WHERE NAME='transaction'");
      await pool.query("UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME='events_transactions_current'");
      const acquire = pool.getConnection.bind(pool);
      pool.getConnection = async () => {
        const connection = await acquire();
        const execute = connection.execute.bind(connection);
        const commit = connection.commit.bind(connection);
        let claimed = false;
        connection.commit = async () => {
          await commit();
          if (loseCommitAcknowledgement && claimed) { loseCommitAcknowledgement = false; throw new Error("lost COMMIT acknowledgement"); }
        };
        connection.execute = (async (text: string, params: unknown[]) => {
          if (text.includes("attempt_count = attempt_count + 1")) claimed = true;
          const [identity] = await execute(`SELECT CONNECTION_ID() AS connection, t.EVENT_ID AS transaction, t.ISOLATION_LEVEL AS isolation
            FROM performance_schema.threads th LEFT JOIN performance_schema.events_transactions_current t ON t.THREAD_ID = th.THREAD_ID
            WHERE th.PROCESSLIST_ID = CONNECTION_ID()`);
          trace.push({ text, connection: String((identity as any)[0].connection), transaction: String((identity as any)[0].transaction), isolation: (identity as any)[0].isolation });
          return execute(text, params as never);
        }) as typeof connection.execute;
        const release = connection.release.bind(connection);
        connection.release = () => { connection.execute = execute; connection.commit = commit; connection.release = release; release(); };
        return connection;
      };
      sql = new Mysql2SqlClient(pool as never);
    }
    let schema = sessionExecutionCoordinatorSqlSchema;
    if (backend === "mysql") schema = schema
      .replace(/\b(workspace_id|session_id|lane_id|id|state|attempt_id|owner_id) TEXT/g, "$1 VARCHAR(191)")
      .replaceAll("CREATE INDEX IF NOT EXISTS", "CREATE INDEX");
    await sql.exec(schema);
    const capability = await sql.rowLockTransactions!.capability(["managed_session_executions", "managed_session_claim_locks"]);
    evidence("REAL_SERVER_METADATA", { backend, capability, isolation: "READ COMMITTED", resources: localFixture ? "task-owned local processes" : "testcontainers task-owned" });
    expect(capability.supported).toBe(true);
  });
  afterAll(async () => { await close?.(); await container?.stop(); });
  beforeEach(async () => {
    await sql.exec("DELETE FROM managed_session_executions; DELETE FROM managed_session_claim_locks;"); trace.length = 0; loseCommitAcknowledgement = false;
  });
  const coordinator = (serial = false) => new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: serial });
  const admit = async (id: string, session = id, lane = "primary", order = 0) => {
    await coordinator().admit({ execution: { id, workspaceId: "ws", sessionId: session, laneId: lane,
      admittedAt: new Date(now.getTime() + order).toISOString(), events: [{ id: `event-${id}`, type: "user.message", content: [{ type: "text", text: id }], processedAt: now.toISOString() }] } });
    await sql.prepare("INSERT INTO managed_session_claim_locks (workspace_id, session_id, claim_token, version) VALUES (?, ?, ?, 0) ON CONFLICT (workspace_id, session_id) DO NOTHING").bind("ws", session, "seed").run();
  };
  const claim = (id: string, serial = false) => coordinator(serial).claim({ ownerId: id, attemptId: `attempt-${id}`, claimedAt: new Date(now.getTime() + 100).toISOString(), leaseTtlMs: 30_000 });
  async function hold(table: string, field: string, id: string, body: () => Promise<void>) {
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const holding = sql.rowLockTransactions!.run(async tx => {
      await tx.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND ${field} = ? FOR UPDATE`).bind("ws", id).all();
      locked(); await gate;
    });
    try { await ready; await body(); } finally { release(); await holding; }
  }
  sessionExecutionStoreConformance(`real ${backend} SKIP LOCKED`, {
    withStore: async (_fixture, run) => run(coordinator()),
  });
  it("does not reclaim scoped recovery before canonical evidence authorizes it", async () => {
    await admit("a", "session");
    const scoped = new SqlSessionExecutionCoordinator(sql, { recoveryScope: { workspaceId: "ws", sessionId: "session" } });
    const request = { workspaceId: "ws", sessionId: "session", ownerId: "old", attemptId: "old-attempt", claimedAt: new Date(now.getTime() + 100).toISOString(), leaseTtlMs: 1000 };
    expect((await scoped.claim(request)).type).toBe("claimed");
    expect(await scoped.claim({ ...request, excludeAttemptIds: [request.attemptId] })).toEqual({ type: "empty" });
    expect(await scoped.claim({ ...request, claimedAt: new Date(now.getTime() + 2000).toISOString() })).toEqual({ type: "empty" });
    expect(await scoped.claim({ ...request, ownerId: "new", attemptId: "new-attempt", claimedAt: new Date(now.getTime() + 2000).toISOString() })).toEqual({ type: "empty" });
    expect(await scoped.find({ workspaceId: "ws", executionId: "a" })).toMatchObject({ state: "running", attempt: { id: "old-attempt", ownerId: "old", generation: 1 } });
  });
  it("distributes tasks across independent concurrent transactions with no duplicate winner", async () => {
    for (let i = 0; i < 8; i++) await admit(`e${i}`);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(`worker${i}`)));
    expect(results.every(result => result.type === "claimed")).toBe(true);
    expect(new Set(results.map(result => result.type === "claimed" ? result.execution.id : "empty")).size).toBe(8);
  });
  it.each([false, true])("skips locked head without same-session/lane overtaking (serial=%s)", async serial => {
    await admit("a", "session", "one"); await admit("b", "session", serial ? "two" : "one", 1); await admit("c", "other", "one", 2);
    await hold("managed_session_executions", "id", "a", async () => {
      const result = await claim("worker", serial);
      expect(result.type === "claimed" && result.execution.id).toBe("c");
      expect((await claim("second", serial)).type).toBe("empty");
    });
    expect((await claim("third", serial)).type).toBe("claimed");
  });
  it("locks the session mutex first and allows another session while it is held", async () => {
    await admit("a", "session"); await admit("b", "other", "one", 1);
    await hold("managed_session_claim_locks", "session_id", "session", async () => {
      trace.length = 0;
      const result = await claim("worker", true);
      expect(result.type === "claimed" && result.execution.id).toBe("b");
      const locks = trace.filter(entry => entry.text.includes("FOR UPDATE SKIP LOCKED"));
      expect(locks[0].text).toContain("managed_session_claim_locks");
      expect(locks.findIndex(entry => entry.text.includes("FROM managed_session_executions"))).toBeGreaterThan(0);
    });
  });
  it("rolls back every mutation on validation rejection and releases the connection and locks", async () => {
    await admit("a"); let retained!: SqlTransaction; let statement!: SqlStatement;
    await expect(sql.rowLockTransactions!.run(async tx => {
      retained = tx; statement = tx.prepare("SELECT id FROM managed_session_executions");
      await tx.prepare("SELECT id FROM managed_session_executions WHERE id = ? FOR UPDATE SKIP LOCKED").bind("a").first();
      await tx.prepare("UPDATE managed_session_executions SET state = 'failed' WHERE id = ? RETURNING id").bind("a").first();
      await tx.prepare("UPDATE managed_session_claim_locks SET version = 100").run();
      throw new Error("validation rejected");
    })).rejects.toThrow("validation rejected");
    expect(() => retained.prepare("SELECT 1")).toThrow("closed");
    await expect(statement.first()).rejects.toThrow("closed");
    expect(await sql.prepare("SELECT version FROM managed_session_claim_locks").first()).toMatchObject({ version: backend === "postgres" ? "0" : 0 });
    expect((await claim("after-rollback")).type).toBe("claimed");
  });
  it("serial claims give one session a single authority while different sessions proceed", async () => {
    await admit("a", "same", "one"); await admit("b", "same", "two", 1); await admit("c", "different", "one", 2);
    const results = await Promise.all([claim("one", true), claim("two", true), claim("three", true)]);
    const winners = results.flatMap(result => result.type === "claimed" ? [result.execution] : []);
    expect(winners.map(execution => execution.id).sort()).toEqual(["a", "c"]);
    expect(winners.filter(execution => execution.sessionId === "same")).toHaveLength(1);
  });
  it("claim decoding failure rolls back execution and mutex, repeatedly without leaking connections", async () => {
    await admit("a");
    await sql.prepare("UPDATE managed_session_executions SET events_json = ? WHERE id = ?").bind("{broken", "a").run();
    for (let i = 0; i < 10; i++) await expect(claim(`invalid-${i}`, true)).rejects.toThrow();
    const row = await sql.prepare("SELECT state, attempt_count, generation FROM managed_session_executions WHERE id = ?").bind("a").first<any>();
    expect(row.state).toBe("queued"); expect(Number(row.attempt_count)).toBe(0); expect(Number(row.generation)).toBe(0);
    const lock = await sql.prepare("SELECT version FROM managed_session_claim_locks").first<any>(); expect(Number(lock.version)).toBe(0);
    await sql.prepare("UPDATE managed_session_executions SET events_json = ? WHERE id = ?").bind("[]", "a").run();
    expect((await claim("valid", true)).type).toBe("claimed");
  });
  it("commits before external work and proves the claim row is unlocked from an independent connection", async () => {
    await admit("a");
    let inspect!: () => void; let ready!: () => void; let release!: () => void;
    const inspectGate = new Promise<void>(resolve => { inspect = resolve; });
    const observerReady = new Promise<void>(resolve => { ready = resolve; });
    let externalCompleted = false;
    const external = new Promise<void>(resolve => { release = resolve; }).then(() => { externalCompleted = true; });
    // Reserve the observer's real connection before claiming. The claim must
    // use a different physical connection, not merely re-checkout its own.
    const observer = sql.rowLockTransactions!.run(async tx => {
      await tx.prepare("SELECT 1").first(); ready(); await inspectGate;
      expect(await tx.prepare("SELECT id FROM managed_session_executions WHERE id = ? FOR UPDATE SKIP LOCKED").bind("a").first()).toEqual({ id: "a" });
      expect(externalCompleted).toBe(false);
    });
    try {
      await observerReady;
      expect((await claim("worker")).type).toBe("claimed");
      inspect(); await observer;
      const locks = trace.filter(entry => entry.text.includes("FOR UPDATE SKIP LOCKED"));
      expect(new Set(locks.map(entry => entry.connection)).size).toBe(2);
    } finally { inspect(); release(); await external; await observer; }
  });
  it("does not replay an ambiguously acknowledged real COMMIT and recovers the same attempt", async () => {
    await admit("a"); await admit("b", "other", "primary", 1);
    loseCommitAcknowledgement = true;
    await expect(claim("same", true)).rejects.toThrow("lost COMMIT acknowledgement");
    expect(await coordinator().find({ workspaceId: "ws", executionId: "a" })).toMatchObject({ state: "running", attemptCount: 1, attempt: { id: "attempt-same", generation: 1 } });
    const retried = await claim("same", true);
    expect(retried.type === "claimed" && retried.execution.id).toBe("a");
    expect(retried.type === "claimed" && retried.execution.attemptCount).toBe(1);
    expect(await coordinator().find({ workspaceId: "ws", executionId: "b" })).toMatchObject({ state: "queued", attemptCount: 0 });
  });
  it("select, mutation and RETURNING read-back share a real connection and transaction", async () => {
    await admit("a"); trace.length = 0; await claim("worker", true);
    const selected = trace.filter(entry => entry.text.includes("FOR UPDATE SKIP LOCKED"));
    expect(selected.length).toBe(2);
    const mutations = trace.filter(entry => /^\s*UPDATE\b/.test(entry.text));
    expect(mutations.length).toBe(2);
    const readback = trace.filter(entry => /^SELECT workspace_id, session_id/.test(entry.text));
    if (backend === "mysql") expect(readback.length).toBeGreaterThan(0);
    const relevant = [...selected, ...mutations, ...readback];
    expect(new Set(relevant.map(entry => entry.connection)).size).toBe(1);
    expect(new Set(relevant.map(entry => entry.transaction)).size).toBe(1);
    expect(relevant.every(entry => entry.transaction !== undefined && entry.transaction !== "null")).toBe(true);
    if (backend === "mysql") expect(relevant.every(entry => entry.isolation === "READ COMMITTED")).toBe(true);
    evidence("CLAIM_TRANSACTION_TRACE", { backend, statements: relevant });
  });
});
