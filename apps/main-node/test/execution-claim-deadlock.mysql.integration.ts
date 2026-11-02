import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMysql2SqlClient,
  setDbBoundaryLogger,
  withDbBoundary,
  type DbBoundaryLog,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  ensureSessionExecutionClaimLockSchema,
  SqlSessionExecutionCoordinator,
} from "@open-managed-agents/session-runtime-sql";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { openNodeDatabase } from "../src/database.js";
import { NodeSessionExecutionWorker } from "../../../packages/control-plane-node/src/lib/node-session-execution-worker.js";

/**
 * Concurrent replicas against one MySQL 8.4 (REPEATABLE READ).
 * On the pre-fix store this reproduces ER_LOCK_DEADLOCK (1213) between
 * terminalizeExpired's claim_idx range update and primary-key renew/settle,
 * plus the unhandled rejection that exits Node when settle rejects.
 * After the fix the same run must stay at zero deadlocks, crashes, and
 * stuck-running rows, with at most one live lane per serialized session.
 */

const iterations = positiveInt(process.env.OMA_DEADLOCK_ITERS, 3);
const hammerMs = positiveInt(process.env.OMA_DEADLOCK_MS, 4_000);
const claimers = positiveInt(process.env.OMA_DEADLOCK_CLAIMERS, 8);
const renewers = positiveInt(process.env.OMA_DEADLOCK_RENEWERS, 8);

let container: StartedMySqlContainer;
let url: string;
let rootUrl: string;

beforeAll(async () => {
  container = await new MySqlContainer("mysql:8.4").start();
  url = container.getConnectionUri();
  rootUrl = container.getConnectionUri(true);
  const database = await openNodeDatabase({ kind: "mysql", url });
  try {
    await ensureSessionExecutionClaimLockSchema(database.sql, "mysql");
  } finally {
    await database.stop?.();
  }
  const admin = await mysql.createConnection(rootUrl);
  try {
    await admin.query("SET GLOBAL innodb_print_all_deadlocks = ON");
    const [isolation] = await admin.query(
      "SELECT @@transaction_isolation AS isolation, @@version AS version, @@innodb_print_all_deadlocks AS print_deadlocks",
    );
    console.log("[deadlock-repro] server", JSON.stringify(isolation));
  } finally {
    await admin.end();
  }
  setDbBoundaryLogger((record) => {
    boundaryLogs.push(record);
    if (record.outcome === "error" || record.retryCount > 0) {
      console.log(JSON.stringify({ msg: "db.boundary", ...record }));
    }
  });
}, 180_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

const boundaryLogs: DbBoundaryLog[] = [];

describe("MySQL execution claim/renew/settle concurrency", () => {
  it("does not deadlock, crash, stick, or double-run under concurrent replicas", async () => {
    const summaries = [];
    let latestStatus = "";
    for (let index = 0; index < iterations; index++) {
      const summary = await hammerOnce(index);
      summaries.push(summary);
      if (summary.innodbStatus) latestStatus = summary.innodbStatus;
      console.log("[deadlock-repro] iteration", JSON.stringify({
        index,
        deadlocks: summary.deadlocks,
        crashes: summary.crashes,
        stuckRunning: summary.stuckRunning,
        duplicateSessions: summary.duplicateSessions,
        claims: summary.claims,
        renews: summary.renews,
        settles: summary.settles,
        otherErrors: summary.otherErrors,
      }));
    }
    const totals = summaries.reduce((acc, summary) => ({
      deadlocks: acc.deadlocks + summary.deadlocks,
      crashes: acc.crashes + summary.crashes,
      stuckRunning: acc.stuckRunning + summary.stuckRunning,
      duplicateSessions: acc.duplicateSessions + summary.duplicateSessions,
    }), { deadlocks: 0, crashes: 0, stuckRunning: 0, duplicateSessions: 0 });
    const evidence = `${JSON.stringify(totals)}\n${latestStatus.slice(0, 12_000)}`;
    expect(totals.deadlocks, evidence).toBe(0);
    expect(totals.crashes, evidence).toBe(0);
    expect(totals.stuckRunning, evidence).toBe(0);
    expect(totals.duplicateSessions, evidence).toBe(0);
    const retried = boundaryLogs.filter((record) => record.retryCount > 0 || record.outcome === "error");
    const evidencePath = "/tmp/oma-deadlock-evidence.json";
    writeFileSync(evidencePath, JSON.stringify({
      iterations: summaries,
      totals,
      retried: retried.slice(0, 30),
    }, null, 2));
    console.log("[deadlock-repro] boundary anomalies", JSON.stringify(retried.slice(0, 20)));
    console.log("[deadlock-repro] wrote", evidencePath);
    boundaryLogs.length = 0;
  }, 180_000);

  it("terminalizes an expired lease and keeps a single running lane per serialized session", async () => {
    const sql = await createMysql2SqlClient(url, { connectionLimit: 4 });
    const workspaceId = `ws_${randomUUID()}`;
    try {
      const coordinator = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
      const admittedAt = new Date(Date.now() - 5_000).toISOString();
      await coordinator.admit({
        execution: execution(workspaceId, "session_poison", "poison", "sthr_primary", admittedAt),
        policy: { maxAttempts: 1, timeoutMs: 60_000 },
      });
      const claimedAt = new Date(Date.now() - 3_000).toISOString();
      const claimed = await coordinator.claim({
        workspaceId,
        ownerId: "owner_dead",
        attemptId: "attempt_poison",
        claimedAt,
        leaseTtlMs: 1_000,
      });
      expect(claimed.type).toBe("claimed");
      const blocked = await coordinator.claim({
        workspaceId,
        ownerId: "owner_next",
        attemptId: "attempt_poison_2",
        claimedAt: new Date().toISOString(),
        leaseTtlMs: 30_000,
      });
      expect(blocked).toEqual({ type: "empty" });
      await expect(coordinator.find({ workspaceId, executionId: "poison" })).resolves.toMatchObject({
        state: "failed",
        failure: "execution attempt limit exhausted",
      });

      const sessionId = "session_serial";
      for (const laneId of ["sthr_primary", "sthr_child"]) {
        await coordinator.admit({
          execution: execution(workspaceId, sessionId, `exec_${laneId}`, laneId, admittedAt),
        });
      }
      const racers = await Promise.all([0, 1, 2, 3].map((index) => {
        return new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true }).claim({
          workspaceId,
          sessionId,
          ownerId: `racer_${index}`,
          attemptId: `attempt_${index}`,
          claimedAt: new Date().toISOString(),
          leaseTtlMs: 30_000,
        });
      }));
      expect(racers.filter((result) => result.type === "claimed")).toHaveLength(1);
      const running = await sql.prepare(
        `SELECT COUNT(*) AS n FROM managed_session_executions
          WHERE workspace_id = ? AND session_id = ? AND state = 'running'`,
      ).bind(workspaceId, sessionId).first<{ n: number | string }>();
      expect(Number(running?.n ?? 0)).toBe(1);
    } finally {
      await sql.prepare("DELETE FROM managed_session_executions WHERE workspace_id = ?").bind(workspaceId).run();
      await sql.prepare("DELETE FROM managed_session_claim_locks WHERE workspace_id = ?").bind(workspaceId).run();
      await sql.close();
    }
  }, 60_000);

  it("logs a Timeout when renew waits past the configured deadline", async () => {
    const sql = await createMysql2SqlClient(url, { connectionLimit: 2 });
    const workspaceId = `ws_timeout_${randomUUID()}`;
    const raw = await mysql.createConnection(url);
    const before = boundaryLogs.length;
    try {
      const coordinator = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
      const admittedAt = new Date().toISOString();
      await coordinator.admit({
        execution: execution(workspaceId, "session_timeout", "exec_timeout", "sthr_primary", admittedAt),
      });
      const claimed = await coordinator.claim({
        workspaceId,
        ownerId: "owner_timeout",
        attemptId: "attempt_timeout",
        claimedAt: admittedAt,
        leaseTtlMs: 60_000,
      });
      expect(claimed.type).toBe("claimed");
      if (claimed.type !== "claimed") return;
      await raw.beginTransaction();
      await raw.query(
        "UPDATE managed_session_executions SET revision = revision + 1 WHERE workspace_id = ? AND id = ?",
        [workspaceId, "exec_timeout"],
      );
      await expect(withDbBoundary({
        op: "session_execution.heartbeat",
        sessionId: "session_timeout",
        timeoutMs: 200,
      }, () => coordinator.renew({
        fence: claimed.fence,
        renewedAt: new Date().toISOString(),
        leaseTtlMs: 30_000,
      }))).rejects.toMatchObject({ _tag: "Timeout", timeoutMs: 200, sessionId: "session_timeout" });
      const record = boundaryLogs.slice(before).find((entry) => entry.errorTag === "Timeout");
      writeFileSync("/tmp/oma-forced-timeout.json", JSON.stringify(record, null, 2));
      console.log(JSON.stringify({ msg: "db.boundary", ...record }));
      expect(record).toMatchObject({
        op: "session_execution.heartbeat",
        sessionId: "session_timeout",
        timeoutMs: 200,
        outcome: "error",
        errorTag: "Timeout",
      });
      expect(record?.durationMs ?? 0).toBeGreaterThanOrEqual(180);
    } finally {
      await raw.rollback().catch(() => undefined);
      await raw.end();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await sql.prepare("DELETE FROM managed_session_executions WHERE workspace_id = ?").bind(workspaceId).run().catch(() => undefined);
      await sql.prepare("DELETE FROM managed_session_claim_locks WHERE workspace_id = ?").bind(workspaceId).run().catch(() => undefined);
      await sql.close();
    }
  }, 30_000);

  it("logs a Deadlock when two transactions lock rows in opposite orders", async () => {
    const admin = await mysql.createConnection(rootUrl);
    try {
      await admin.query("DROP TABLE IF EXISTS deadlock_probe");
      await admin.query(`
        CREATE TABLE deadlock_probe (
          id VARCHAR(16) NOT NULL PRIMARY KEY,
          revision INT NOT NULL
        ) ENGINE=InnoDB
      `);
      await admin.query("INSERT INTO deadlock_probe (id, revision) VALUES ('a', 0), ('b', 0)");
    } finally {
      await admin.end();
    }

    let captured: DbBoundaryLog | undefined;
    const probeLogs: DbBoundaryLog[] = [];
    for (let attempt = 0; attempt < 12 && captured === undefined; attempt++) {
      const raw = await mysql.createConnection(url);
      const sql = await createMysql2SqlClient(url, { connectionLimit: 1 });
      const before = boundaryLogs.length;
      try {
        await raw.beginTransaction();
        // Extra undo records so InnoDB prefers to roll back the one-row client batch.
        for (let undo = 0; undo < 8; undo++) {
          await raw.query("UPDATE deadlock_probe SET revision = revision + 1 WHERE id = 'b'");
        }
        const batch = withDbBoundary({
          op: "deadlock_probe",
          sessionId: "session_probe",
        }, () => sql.batch([
          sql.prepare("UPDATE deadlock_probe SET revision = revision + 1 WHERE id = ?").bind("a"),
          sql.prepare("UPDATE deadlock_probe SET revision = revision + 1 WHERE id = ?").bind("b"),
        ]));
        await new Promise((resolve) => setTimeout(resolve, 250));
        await raw.query("UPDATE deadlock_probe SET revision = revision + 1 WHERE id = 'a'").catch(() => undefined);
        await raw.rollback().catch(() => undefined);
        await batch.catch(() => undefined);
        const slice = boundaryLogs.slice(before);
        probeLogs.push(...slice);
        captured = slice.find((entry) => entry.errorTag === "Deadlock");
      } finally {
        await raw.end().catch(() => undefined);
        await sql.close().catch(() => undefined);
      }
    }
    writeFileSync("/tmp/oma-forced-deadlock.json", JSON.stringify({ captured, probeLogs }, null, 2));
    console.log(JSON.stringify({ msg: "db.boundary", ...captured }));
    expect(captured).toMatchObject({
      op: "deadlock_probe",
      sessionId: "session_probe",
      errorTag: "Deadlock",
    });
    expect((captured?.retryCount ?? 0) + (captured?.outcome === "error" ? 1 : 0)).toBeGreaterThan(0);
  }, 60_000);

  it("keeps the worker fiber alive when a real renew blocks past the heartbeat", async () => {
    const sql = await createMysql2SqlClient(url, { connectionLimit: 4 });
    const workspaceId = `ws_fiber_${randomUUID()}`;
    const raw = await mysql.createConnection(url);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    let release: (() => void) | undefined;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const cancellations: string[] = [];
    const errors: string[] = [];
    try {
      const coordinator = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
      const admittedAt = new Date().toISOString();
      await coordinator.admit({
        execution: execution(workspaceId, "session_fiber", "exec_fiber", "sthr_primary", admittedAt),
      });
      const claimed = await coordinator.claim({
        workspaceId,
        ownerId: "owner_seed",
        attemptId: "seed_fiber",
        claimedAt: admittedAt,
        leaseTtlMs: 60_000,
      });
      expect(claimed.type).toBe("claimed");
      if (claimed.type !== "claimed") return;
      await raw.beginTransaction();
      await raw.query(
        "UPDATE managed_session_executions SET revision = revision + 1 WHERE workspace_id = ? AND id = ?",
        [workspaceId, "exec_fiber"],
      );
      let claims = 0;
      const worker = new NodeSessionExecutionWorker({
        coordinator: {
          ...coordinator,
          admit: coordinator.admit.bind(coordinator),
          claim: async () => {
            claims += 1;
            return claims === 1 ? claimed : { type: "empty" as const };
          },
          find: coordinator.find.bind(coordinator),
          requestInterrupt: coordinator.requestInterrupt.bind(coordinator),
          cancelSession: coordinator.cancelSession.bind(coordinator),
          settle: coordinator.settle.bind(coordinator),
          renew: coordinator.renew.bind(coordinator),
        },
        context: { find: async () => ({ session: {} as never, environment: {} as never, revision: 1 }) },
        runtime: {
          run: async () => { await running; },
          cancel: async (input) => { cancellations.push(input.reason); },
        },
        ownerId: "worker_fiber",
        clock: { now: () => new Date() },
        ids: { nextAttemptId: () => `fiber_${randomUUID()}` },
        leaseTtlMs: 60_000,
        heartbeatIntervalMs: 200,
        pollIntervalMs: 1_000,
        maxConcurrent: 1,
        onError: (error) => { errors.push((error as { _tag?: string })._tag ?? error.message); },
      });
      await worker.poll();
      await new Promise((resolve) => setTimeout(resolve, 700));
      const timeoutLog = boundaryLogs.find((entry) =>
        entry.op === "session_execution.heartbeat" && entry.errorTag === "Timeout" && entry.sessionId === "session_fiber",
      );
      writeFileSync("/tmp/oma-fiber-timeout.json", JSON.stringify({ timeoutLog, errors, cancellations, rejections: rejections.length }, null, 2));
      console.log(JSON.stringify({ msg: "db.boundary", ...timeoutLog }));
      expect(timeoutLog).toMatchObject({
        op: "session_execution.heartbeat",
        sessionId: "session_fiber",
        timeoutMs: 200,
        outcome: "error",
        errorTag: "Timeout",
      });
      expect(cancellations).not.toContain("lease_lost");
      expect(rejections).toEqual([]);
      expect(errors).toContain("Timeout");
      release?.();
      await raw.rollback();
      await worker.waitForIdle();
    } finally {
      process.off("unhandledRejection", onRejection);
      release?.();
      await raw.rollback().catch(() => undefined);
      await raw.end().catch(() => undefined);
      await sql.prepare("DELETE FROM managed_session_executions WHERE workspace_id = ?").bind(workspaceId).run().catch(() => undefined);
      await sql.close().catch(() => undefined);
    }
  }, 30_000);
});

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function execution(
  workspaceId: string,
  sessionId: string,
  id: string,
  laneId: string,
  admittedAt: string,
) {
  return {
    id,
    workspaceId,
    sessionId,
    laneId,
    admittedAt,
    events: [{
      id,
      type: "user.message" as const,
      content: [{ type: "text" as const, text: id }],
      processedAt: admittedAt,
    }],
  };
}

function isDeadlock(error: unknown): boolean {
  const current = error as { errno?: number; code?: string; cause?: unknown; message?: string };
  if (current?.errno === 1213 || current?.code === "ER_LOCK_DEADLOCK") return true;
  if (current?.cause && isDeadlock(current.cause)) return true;
  return typeof current?.message === "string" && current.message.includes("Deadlock found");
}

async function hammerOnce(index: number) {
  const workspaceId = `ws_hammer_${index}_${randomUUID()}`;
  const admin = await createMysql2SqlClient(url, { connectionLimit: 2 });
  const clients: SqlClient[] = [];
  const crashes: unknown[] = [];
  const onRejection = (reason: unknown) => { crashes.push(reason); };
  process.on("unhandledRejection", onRejection);
  let deadlocks = 0;
  let otherErrors = 0;
  let claims = 0;
  let renews = 0;
  let settles = 0;
  let stuckRunning = 0;
  const fences: SessionExecutionFence[] = [];
  try {
    const seeder = new SqlSessionExecutionCoordinator(admin, { serializeSessionClaims: true });
    const admittedAt = new Date().toISOString();
    for (let row = 0; row < 24; row++) {
      const sessionId = `session_run_${row}`;
      await seeder.admit({ execution: execution(workspaceId, sessionId, `run_${row}`, "sthr_primary", admittedAt) });
      const claimed = await seeder.claim({
        workspaceId,
        ownerId: "owner_seed",
        attemptId: `seed_${row}`,
        claimedAt: admittedAt,
        leaseTtlMs: 60_000,
      });
      if (claimed.type === "claimed") fences.push(claimed.fence);
      await seeder.admit({
        execution: execution(workspaceId, sessionId, `queued_${row}`, "sthr_child", admittedAt),
      });
    }
    for (let row = 0; row < 16; row++) {
      await seeder.admit({
        execution: execution(workspaceId, `session_free_${row}`, `free_${row}`, "sthr_primary", admittedAt),
      });
    }

    for (let replica = 0; replica < claimers + renewers; replica++) {
      clients.push(await createMysql2SqlClient(url, { connectionLimit: 2 }));
    }
    const started = Date.now();
    const running = Date.now();
    const loops: Array<Promise<void>> = [];
    for (let replica = 0; replica < claimers; replica++) {
      const client = clients[replica]!;
      loops.push((async () => {
        const coordinator = new SqlSessionExecutionCoordinator(client, { serializeSessionClaims: true });
        while (Date.now() - running < hammerMs) {
          try {
            const claimed = await coordinator.claim({
              ownerId: `claimer_${replica}`,
              attemptId: `claim_${replica}_${randomUUID()}`,
              claimedAt: new Date().toISOString(),
              leaseTtlMs: 30_000,
            });
            if (claimed.type === "claimed") claims += 1;
          } catch (error) {
            if (isDeadlock(error)) deadlocks += 1;
            else otherErrors += 1;
          }
        }
      })());
    }
    for (let replica = 0; replica < renewers; replica++) {
      const client = clients[claimers + replica]!;
      loops.push((async () => {
        const coordinator = new SqlSessionExecutionCoordinator(client, { serializeSessionClaims: true });
        while (Date.now() - running < hammerMs) {
          const fence = fences[replica % fences.length];
          if (!fence) break;
          try {
            const renewed = await coordinator.renew({
              fence,
              renewedAt: new Date().toISOString(),
              leaseTtlMs: 30_000,
            });
            if (renewed.type === "renewed") {
              renews += 1;
              Object.assign(fence, renewed.fence);
            }
          } catch (error) {
            if (isDeadlock(error)) deadlocks += 1;
            else otherErrors += 1;
          }
        }
      })());
    }

    const workerClient = await createMysql2SqlClient(url, { connectionLimit: 2 });
    clients.push(workerClient);
    const worker = new NodeSessionExecutionWorker({
      coordinator: new SqlSessionExecutionCoordinator(workerClient, { serializeSessionClaims: true }),
      context: { find: async () => ({ session: {} as never, environment: {} as never, revision: 1 }) },
      runtime: {
        run: async () => { await new Promise((resolve) => setTimeout(resolve, 400)); },
        cancel: async () => {},
      },
      ownerId: "worker_settle",
      clock: { now: () => new Date() },
      ids: { nextAttemptId: () => `worker_${randomUUID()}` },
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 40,
      pollIntervalMs: 40,
      maxConcurrent: 4,
      onError: (error) => {
        if (isDeadlock(error)) deadlocks += 1;
        else otherErrors += 1;
      },
    });
    const workerCoordinator = new SqlSessionExecutionCoordinator(admin, { serializeSessionClaims: true });
    for (let row = 0; row < 4; row++) {
      await workerCoordinator.admit({
        execution: execution(workspaceId, `session_worker_${row}`, `worker_${row}`, "sthr_primary", admittedAt),
      });
    }
    worker.start();
    await Promise.all(loops);
    await new Promise((resolve) => setTimeout(resolve, 800));
    worker.stop();

    const settledTargets = fences.slice(0, 6);
    for (const fence of settledTargets) {
      try {
        const settled = await seeder.settle({
          fence,
          settledAt: new Date().toISOString(),
          outcome: "completed",
        });
        if (settled.type === "settled") settles += 1;
        else {
          const current = await seeder.find({ workspaceId: fence.workspaceId, executionId: fence.executionId });
          if (current?.state === "running" && current.attempt?.id === fence.attemptId) stuckRunning += 1;
        }
      } catch (error) {
        if (isDeadlock(error)) deadlocks += 1;
        else otherErrors += 1;
        const current = await seeder.find({ workspaceId: fence.workspaceId, executionId: fence.executionId });
        if (current?.state === "running") stuckRunning += 1;
      }
    }

    const duplicates = await admin.prepare(
      `SELECT session_id AS sessionId, COUNT(*) AS n
         FROM managed_session_executions
        WHERE workspace_id = ? AND state = 'running' AND lease_expires_at_ms > ?
        GROUP BY session_id
       HAVING COUNT(*) > 1`,
    ).bind(workspaceId, Date.now()).all<{ sessionId: string; n: number }>();
    const duplicateSessions = duplicates.results?.length ?? 0;
    const status = await innodbStatus();
    if (deadlocks > 0) console.log(status);
    return {
      deadlocks,
      crashes: crashes.length,
      stuckRunning,
      duplicateSessions,
      claims,
      renews,
      settles,
      otherErrors,
      elapsedMs: Date.now() - started,
      innodbStatus: deadlocks > 0 ? extractDeadlock(status) : "",
    };
  } finally {
    process.off("unhandledRejection", onRejection);
    await admin.prepare("DELETE FROM managed_session_executions WHERE workspace_id = ?").bind(workspaceId).run().catch(() => undefined);
    await admin.prepare("DELETE FROM managed_session_claim_locks WHERE workspace_id = ?").bind(workspaceId).run().catch(() => undefined);
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await admin.close();
  }
}

async function innodbStatus(): Promise<string> {
  const connection = await mysql.createConnection(rootUrl);
  try {
    const [rows] = await connection.query("SHOW ENGINE INNODB STATUS");
    const status = (rows as Array<{ Status?: string }>)[0]?.Status ?? "";
    return status;
  } finally {
    await connection.end();
  }
}

function extractDeadlock(status: string): string {
  const start = status.indexOf("LATEST DETECTED DEADLOCK");
  if (start === -1) return status.slice(0, 4_000);
  return status.slice(start, start + 8_000);
}
