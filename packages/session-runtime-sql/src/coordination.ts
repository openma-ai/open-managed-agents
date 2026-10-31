import type {
  AdmitSessionExecution,
  AdmitSessionExecutionResult,
  ClaimSessionExecution,
  ClaimSessionExecutionResult,
  RenewSessionExecutionResult,
  SessionExecution,
  SessionExecutionStorePort,
  SessionExecutionFence,
  SettleSessionExecutionResult,
} from "@open-managed-agents/session-runtime-contract/coordination";
import {
  annotateDbBoundary,
  CasConflict,
  isCasConflict,
  withDbBoundary,
} from "@open-managed-agents/sql-client/db-errors";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { Cause, Effect, Exit, Option } from "effect";

/** Row is a turn continuation (client answer to a paused tool call). */
const CONTINUATION_SQL = (alias: string) =>
  `${alias}.events_json LIKE '%"type":"user.custom_tool_result"%' OR ` +
  `${alias}.events_json LIKE '%"type":"user.tool_confirmation"%'`;

/** Promise port over an Effect program. FiberFailure stays inside. */
function runCoordinatorPort<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    throw Cause.squash(exit.cause);
  });
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS managed_session_executions (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    lane_id TEXT NOT NULL,
    id TEXT NOT NULL,
    admitted_at_ms BIGINT NOT NULL,
    events_json TEXT NOT NULL,
    events_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt_id TEXT,
    owner_id TEXT,
    generation BIGINT NOT NULL DEFAULT 0,
    attempt_count BIGINT NOT NULL DEFAULT 0,
    max_attempts BIGINT NOT NULL DEFAULT 10,
    deadline_at_ms BIGINT NOT NULL,
    claimed_at_ms BIGINT,
    lease_expires_at_ms BIGINT,
    interrupt_requested_at_ms BIGINT,
    settled_at_ms BIGINT,
    failure TEXT,
    revision BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY (workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS managed_session_executions_claim_idx
    ON managed_session_executions
      (state, lease_expires_at_ms, admitted_at_ms, id)`,
  `CREATE INDEX IF NOT EXISTS managed_session_executions_session_idx
    ON managed_session_executions
      (workspace_id, session_id, lane_id, admitted_at_ms, id)`,
  `CREATE TABLE IF NOT EXISTS managed_session_claim_locks (
    workspace_id VARCHAR(191) NOT NULL, session_id VARCHAR(191) NOT NULL,
    claim_token VARCHAR(191) NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    holder_execution_id VARCHAR(191),
    PRIMARY KEY (workspace_id, session_id)
  )`,
] as const;

export const sessionExecutionCoordinatorSqlSchema =
  `${schemaStatements.join(";\n")};`;

/** Node migrations already created the execution table. This additive lock
 * table is needed only when checkpoint_restore selects cross-lane serial mode. */
export async function ensureSessionExecutionClaimLockSchema(
  sql: SqlClient,
  dialect?: "sqlite" | "mysql" | "postgres",
): Promise<void> {
  // Node's consolidated MySQL baseline uses utf8mb4_unicode_ci even when
  // the database default differs. Cross-table lock comparisons must use the
  // same collation as managed_session_executions.
  await sql.exec(schemaStatements[3] + (dialect === "mysql"
    ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    : ""));
  await upgradeSessionClaimLockColumns(sql, dialect);
}

/**
 * Additive columns for the per-session CAS mutex. Old replicas ignore them
 * (`claim_token` stays NOT NULL). New replicas compare `version`.
 */
export async function upgradeSessionClaimLockColumns(
  sql: SqlClient,
  dialect?: "sqlite" | "mysql" | "postgres",
): Promise<void> {
  const names = await claimLockColumnNames(sql, dialect);
  if (names === null || names.size === 0) return;
  if (!names.has("version")) {
    await sql.exec(
      "ALTER TABLE managed_session_claim_locks ADD COLUMN version BIGINT NOT NULL DEFAULT 0",
    );
  }
  if (!names.has("holder_execution_id")) {
    await sql.exec(
      "ALTER TABLE managed_session_claim_locks ADD COLUMN holder_execution_id VARCHAR(191)",
    );
  }
}

async function claimLockColumnNames(
  sql: SqlClient,
  dialect?: "sqlite" | "mysql" | "postgres",
): Promise<Set<string> | null> {
  const collect = (rows: Array<{ name?: string }> | undefined) =>
    new Set(
      (rows ?? [])
        .map((row) => row.name?.toLowerCase())
        .filter((name): name is string => typeof name === "string"),
    );
  if (dialect === "postgres") {
    const rows = await sql.prepare(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_name = 'managed_session_claim_locks'`,
    ).all<{ name?: string }>();
    return collect(rows.results);
  }
  if (dialect === "mysql") {
    const rows = await sql.prepare(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'managed_session_claim_locks'`,
    ).all<{ name?: string }>();
    return collect(rows.results);
  }
  try {
    const rows = await sql.prepare(
      "PRAGMA table_info(managed_session_claim_locks)",
    ).all<{ name?: string }>();
    return collect(rows.results);
  } catch {
    try {
      const rows = await sql.prepare(
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'managed_session_claim_locks'`,
      ).all<{ name?: string }>();
      return collect(rows.results);
    } catch {
      return null;
    }
  }
}

export async function ensureSessionExecutionCoordinatorSchema(
  sql: SqlClient,
): Promise<void> {
  // Create the table first.  Index DDL is deferred until after the additive
  // upgrade below so an old SQLite table without `lane_id` can be upgraded
  // without failing on the new session index.
  await sql.exec(schemaStatements[0]);

  // A few self-host installations created the execution table from an
  // earlier preview of this contract.  `CREATE TABLE IF NOT EXISTS` quite
  // correctly leaves those tables untouched, but a subsequent INSERT would
  // then fail on the newly required lease columns.  SQLite/D1 expose
  // `PRAGMA table_info`; PostgreSQL does not, so the probe is intentionally
  // best-effort and the real PG migrations remain the source of truth there.
  let existing: Set<string> | null = null;
  try {
    const result = await sql
      .prepare("PRAGMA table_info(managed_session_executions)")
      .all<{ name?: string }>();
    existing = new Set(
      (result.results ?? [])
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"),
    );
  } catch {
    // PostgreSQL (and non-SQLite adapters) use their own migration runner.
  }
  if (existing !== null && existing.size > 0) {
    const additions: Array<[string, string]> = [
      ["lane_id", "TEXT NOT NULL DEFAULT 'sthr_primary'"],
      ["events_fingerprint", "TEXT NOT NULL DEFAULT ''"],
      ["generation", "BIGINT NOT NULL DEFAULT 0"],
      ["attempt_count", "BIGINT NOT NULL DEFAULT 0"],
      ["max_attempts", "BIGINT NOT NULL DEFAULT 10"],
      ["deadline_at_ms", "BIGINT NOT NULL DEFAULT 253402300799999"],
      ["claimed_at_ms", "BIGINT"],
      ["lease_expires_at_ms", "BIGINT"],
      ["interrupt_requested_at_ms", "BIGINT"],
      ["settled_at_ms", "BIGINT"],
      ["failure", "TEXT"],
      ["revision", "BIGINT NOT NULL DEFAULT 1"],
    ];
    for (const [name, definition] of additions) {
      if (!existing.has(name)) {
        await sql.exec(
          `ALTER TABLE managed_session_executions ADD COLUMN ${name} ${definition}`,
        );
      }
    }
  }
  for (const statement of schemaStatements.slice(1)) await sql.exec(statement);
  await upgradeSessionClaimLockColumns(sql);
}

interface ExecutionRow {
  workspace_id: string;
  session_id: string;
  lane_id: string;
  id: string;
  admitted_at_ms: number | string;
  events_json: string;
  events_fingerprint: string;
  state: SessionExecution["state"];
  attempt_id: string | null;
  owner_id: string | null;
  generation: number | string;
  attempt_count: number | string;
  max_attempts: number | string;
  deadline_at_ms: number | string;
  claimed_at_ms: number | string | null;
  lease_expires_at_ms: number | string | null;
  interrupt_requested_at_ms: number | string | null;
  settled_at_ms: number | string | null;
  failure: string | null;
  revision: number | string;
}

function timestamp(value: string, name: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`Invalid ${name} timestamp`);
  }
  return milliseconds;
}

function safeInteger(value: number | string, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

function optionalDate(value: number | string | null, name: string): string | null {
  return value === null
    ? null
    : new Date(safeInteger(value, name)).toISOString();
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function columns(): string {
  return `workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
    events_fingerprint, state, attempt_id, owner_id, generation,
    attempt_count, max_attempts, deadline_at_ms,
    claimed_at_ms, lease_expires_at_ms, interrupt_requested_at_ms,
    settled_at_ms, failure, revision`;
}

function toExecution(row: ExecutionRow): SessionExecution {
  const generation = safeInteger(row.generation, "execution generation");
  const claimedAt = optionalDate(row.claimed_at_ms, "claim time");
  const leaseExpiresAt = optionalDate(row.lease_expires_at_ms, "lease expiry");
  const attempt = row.attempt_id === null || row.owner_id === null ||
      claimedAt === null || leaseExpiresAt === null
    ? null
    : {
        id: row.attempt_id,
        ownerId: row.owner_id,
        generation,
        claimedAt,
        leaseExpiresAt,
      };
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    laneId: row.lane_id,
    admittedAt: new Date(
      safeInteger(row.admitted_at_ms, "admission time"),
    ).toISOString(),
    events: JSON.parse(row.events_json) as SessionExecution["events"],
    state: row.state,
    attempt,
    attemptCount: safeInteger(row.attempt_count, "execution attempt count"),
    maxAttempts: safeInteger(row.max_attempts, "execution max attempts"),
    deadlineAt: new Date(
      safeInteger(row.deadline_at_ms, "execution deadline"),
    ).toISOString(),
    interruptRequestedAt: optionalDate(
      row.interrupt_requested_at_ms,
      "interrupt time",
    ),
    settledAt: optionalDate(row.settled_at_ms, "settlement time"),
    failure: row.failure,
    revision: safeInteger(row.revision, "execution revision"),
  };
}

function toFence(row: ExecutionRow): SessionExecutionFence {
  const execution = toExecution(row);
  if (execution.attempt === null) {
    throw new Error("Claimed Session Execution has no attempt");
  }
  return {
    executionId: execution.id,
    workspaceId: execution.workspaceId,
    sessionId: execution.sessionId,
    attemptId: execution.attempt.id,
    ownerId: execution.attempt.ownerId,
    generation: execution.attempt.generation,
    expiresAt: execution.attempt.leaseExpiresAt,
  };
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Session Execution leaseTtlMs must be a positive integer");
  }
}

export interface SqlSessionExecutionStoreOptions {
  /** Only checkpoint_restore enables this: all lanes of a Session share /workspace. */
  serializeSessionClaims?: boolean;
  /**
   * Minimum gap between expiry sweeps, measured on the caller clock.
   * `0` (tests, default) sweeps on every claim and renew. Production uses
   * 5s plus up to 10s of jitter so replicas do not scan in lockstep.
   */
  sweepIntervalMs?: number;
  onError?(error: unknown, op: string): void;
}

export class SqlSessionExecutionStore
  implements SessionExecutionStorePort
{
  #nextSweepAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly sql: SqlClient, private readonly options: SqlSessionExecutionStoreOptions = {}) {}

  async admit(
    input: AdmitSessionExecution,
  ): Promise<AdmitSessionExecutionResult> {
    if (input.execution.events.length === 0) {
      throw new Error("A Session Execution requires at least one event");
    }
    const maxAttempts = input.policy?.maxAttempts ?? 10;
    const timeoutMs = input.policy?.timeoutMs ?? 60 * 60 * 1_000;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error("Session Execution maxAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Session Execution timeoutMs must be a positive integer");
    }
    const admittedAt = timestamp(input.execution.admittedAt, "admission");
    const deadlineAt = admittedAt + timeoutMs;
    if (!Number.isSafeInteger(deadlineAt)) {
      throw new Error("Session Execution deadline exceeds safe timestamp range");
    }
    const eventsJson = stableJson(input.execution.events);
    const inserted = await this.sql.prepare(`
      INSERT INTO managed_session_executions (
        workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
        events_fingerprint, state, generation, attempt_count, max_attempts,
        deadline_at_ms, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?, 1)
      ON CONFLICT (workspace_id, id) DO NOTHING
    `).bind(
      input.execution.workspaceId,
      input.execution.sessionId,
      input.execution.laneId ?? "sthr_primary",
      input.execution.id,
      admittedAt,
      eventsJson,
      eventsJson,
      maxAttempts,
      deadlineAt,
    ).run();
    const execution = await this.find({
      workspaceId: input.execution.workspaceId,
      executionId: input.execution.id,
    });
    if (execution === null) {
      throw new Error("Session Execution vanished after admission");
    }
    if (inserted.meta.changes === 1) return { type: "admitted", execution };
    const sameIdentity = execution.sessionId === input.execution.sessionId &&
      execution.laneId === (input.execution.laneId ?? "sthr_primary") &&
      execution.admittedAt === input.execution.admittedAt &&
      stableJson(execution.events) === eventsJson;
    return sameIdentity
      ? { type: "replayed", execution }
      : { type: "conflict", execution };
  }

  claim(
    input: ClaimSessionExecution,
  ): Promise<ClaimSessionExecutionResult> {
    return runCoordinatorPort(Effect.tryPromise({
      try: () => withDbBoundary({
        op: "session_execution.claim",
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      }, () => this.claimWithCasRetries(input)),
      catch: (error: unknown) => error,
    }));
  }

  /**
   * Optimistic retries when another replica won the same candidate.
   * Transient driver failures are already tagged and retried inside the
   * SQL adapter. This loop only repeats a CasConflict.
   * A per-execution CAS is not enough for serial mode: the versioned
   * session lock row is the mutex, so two lanes cannot both commit.
   */
  private async claimWithCasRetries(
    input: ClaimSessionExecution,
  ): Promise<ClaimSessionExecutionResult> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await this.claimOnce(input);
      } catch (error) {
        if (!isCasConflict(error)) throw error;
      }
    }
    const already = await this.findOwnedAttempt(input.ownerId, input.attemptId);
    return already ?? { type: "empty" };
  }

  private async claimOnce(input: ClaimSessionExecution): Promise<ClaimSessionExecutionResult> {
    validateTtl(input.leaseTtlMs);
    const claimedAt = timestamp(input.claimedAt, "claim");
    await this.sweepExpired(claimedAt);
    const serial = this.options.serializeSessionClaims === true;
    const candidate = await this.selectCandidate(input, claimedAt, serial);
    if (candidate === null) return { type: "empty" };
    annotateDbBoundary({ sessionId: candidate.session_id });
    const claimed = serial
      ? await this.claimSerial(input, claimedAt, candidate)
      : await this.claimByRevision(input, claimedAt, candidate);
    if (claimed !== null) return claimed;
    const already = await this.findOwnedAttempt(input.ownerId, input.attemptId);
    if (already !== null) return already;
    throw new CasConflict({
      op: "session_execution.claim",
      sessionId: candidate.session_id,
      cause: "conditional update matched no row",
    });
  }

  private async selectCandidate(
    input: ClaimSessionExecution,
    claimedAt: number,
    serial: boolean,
  ): Promise<{
    workspace_id: string;
    session_id: string;
    id: string;
    revision: number | string;
  } | null> {
    const continuations = input.continuationsOnly === true;
    return this.sql.prepare(`
      SELECT candidate.workspace_id, candidate.session_id, candidate.id, candidate.revision
        FROM managed_session_executions AS candidate
       WHERE (? IS NULL OR candidate.workspace_id = ?)
         AND (? IS NULL OR candidate.session_id = ?)
         AND (? IS NULL OR candidate.lane_id = ?)
         AND (candidate.state = 'queued' OR (candidate.state = 'running'
           AND candidate.lease_expires_at_ms <= ? AND candidate.owner_id <> ?))
         AND candidate.attempt_count < candidate.max_attempts
         AND candidate.deadline_at_ms > ?
         ${continuations ? `AND (${CONTINUATION_SQL("candidate")})` : ""}
         AND NOT EXISTS (
           SELECT 1 FROM managed_session_executions AS earlier
            WHERE earlier.workspace_id = candidate.workspace_id
              AND earlier.session_id = candidate.session_id
              AND earlier.lane_id = candidate.lane_id
              AND earlier.state IN ('queued', 'running')
              ${continuations ? `AND NOT (earlier.state = 'queued' AND NOT (${CONTINUATION_SQL("earlier")}))` : ""}
              AND (earlier.admitted_at_ms < candidate.admitted_at_ms
                OR (earlier.admitted_at_ms = candidate.admitted_at_ms AND earlier.id < candidate.id))
         )
         ${serial ? `AND NOT EXISTS (
           SELECT 1 FROM managed_session_executions AS active
            WHERE active.workspace_id = candidate.workspace_id
              AND active.session_id = candidate.session_id
              AND active.id <> candidate.id AND active.state = 'running'
              AND active.lease_expires_at_ms > ?
         )` : ""}
       ORDER BY candidate.admitted_at_ms ASC, candidate.id ASC
       LIMIT 1
    `).bind(
      input.workspaceId ?? null, input.workspaceId ?? null,
      input.sessionId ?? null, input.sessionId ?? null,
      input.laneId ?? null, input.laneId ?? null,
      claimedAt, input.ownerId, claimedAt,
      ...(serial ? [claimedAt] : []),
    ).first<{
      workspace_id: string;
      session_id: string;
      id: string;
      revision: number | string;
    }>();
  }

  /**
   * Lock order inside the short transaction: session claim-lock row, then
   * the execution primary key. No claim_idx range scan.
   */
  private async claimSerial(
    input: ClaimSessionExecution,
    claimedAt: number,
    candidate: { workspace_id: string; session_id: string; id: string; revision: number | string },
  ): Promise<ClaimSessionExecutionResult | null> {
    const claimToken = crypto.randomUUID();
    await this.sql.prepare(`
      INSERT INTO managed_session_claim_locks (
        workspace_id, session_id, claim_token, version
      ) VALUES (?, ?, ?, 0)
      ON CONFLICT (workspace_id, session_id) DO NOTHING
    `).bind(candidate.workspace_id, candidate.session_id, claimToken).run();
    const lock = await this.sql.prepare(`
      SELECT version FROM managed_session_claim_locks
       WHERE workspace_id = ? AND session_id = ?
    `).bind(candidate.workspace_id, candidate.session_id).first<{ version: number | string }>();
    if (lock === null) {
      throw new Error("Session claim lock row vanished");
    }
    const version = safeInteger(lock.version, "claim lock version");
    const nextVersion = version + 1;
    const revision = safeInteger(candidate.revision, "execution revision");
    const results = await this.sql.batch<ExecutionRow>([
      this.sql.prepare(`
        UPDATE managed_session_claim_locks
           SET version = version + 1, holder_execution_id = ?, claim_token = ?
         WHERE workspace_id = ? AND session_id = ? AND version = ?
      `).bind(
        candidate.id,
        claimToken,
        candidate.workspace_id,
        candidate.session_id,
        version,
      ),
      this.executionClaimStatement(input, claimedAt, candidate, revision, {
        workspaceId: candidate.workspace_id,
        sessionId: candidate.session_id,
        version: nextVersion,
        holderId: candidate.id,
      }),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return null;
    const row = results[1]?.results?.[0] ?? null;
    return row === null ? null : this.claimedResult(row);
  }

  private async claimByRevision(
    input: ClaimSessionExecution,
    claimedAt: number,
    candidate: { workspace_id: string; session_id: string; id: string; revision: number | string },
  ): Promise<ClaimSessionExecutionResult | null> {
    const revision = safeInteger(candidate.revision, "execution revision");
    const row = await this.executionClaimStatement(
      input, claimedAt, candidate, revision,
    ).first<ExecutionRow>();
    return row === null ? null : this.claimedResult(row);
  }

  private executionClaimStatement(
    input: ClaimSessionExecution,
    claimedAt: number,
    candidate: { workspace_id: string; id: string },
    revision: number,
    lock?: {
      workspaceId: string;
      sessionId: string;
      version: number;
      holderId: string;
    },
  ) {
    const leaseEnd = claimedAt + input.leaseTtlMs;
    return this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'running', attempt_id = ?, owner_id = ?,
             generation = generation + 1, attempt_count = attempt_count + 1,
             claimed_at_ms = ?,
             lease_expires_at_ms = CASE
               WHEN ? < deadline_at_ms THEN ? ELSE deadline_at_ms END,
             settled_at_ms = NULL, failure = NULL, revision = revision + 1
       WHERE workspace_id = ? AND id = ? AND revision = ?
         AND (state = 'queued' OR (state = 'running'
           AND lease_expires_at_ms <= ? AND owner_id <> ?))
         AND attempt_count < max_attempts
         AND deadline_at_ms > ?
         ${lock ? `AND EXISTS (
           SELECT 1 FROM managed_session_claim_locks AS session_lock
            WHERE session_lock.workspace_id = ?
              AND session_lock.session_id = ?
              AND session_lock.version = ?
              AND session_lock.holder_execution_id = ?
         )` : ""}
      RETURNING ${columns()}
    `).bind(
      input.attemptId,
      input.ownerId,
      claimedAt,
      leaseEnd,
      leaseEnd,
      candidate.workspace_id,
      candidate.id,
      revision,
      claimedAt,
      input.ownerId,
      claimedAt,
      ...(lock ? [lock.workspaceId, lock.sessionId, lock.version, lock.holderId] : []),
    );
  }

  private claimedResult(row: ExecutionRow): ClaimSessionExecutionResult {
    return { type: "claimed", execution: toExecution(row), fence: toFence(row) };
  }

  private async findOwnedAttempt(
    ownerId: string,
    attemptId: string,
  ): Promise<ClaimSessionExecutionResult | null> {
    const row = await this.sql.prepare(`
      SELECT ${columns()} FROM managed_session_executions
       WHERE owner_id = ? AND attempt_id = ? AND state = 'running'
    `).bind(ownerId, attemptId).first<ExecutionRow>();
    return row === null ? null : this.claimedResult(row);
  }

  renew(input: {
    fence: SessionExecutionFence;
    renewedAt: string;
    leaseTtlMs: number;
  }): Promise<RenewSessionExecutionResult> {
    return runCoordinatorPort(Effect.tryPromise({
      try: () => withDbBoundary({
      op: "session_execution.renew",
      sessionId: input.fence.sessionId,
    }, async () => {
      validateTtl(input.leaseTtlMs);
      const renewedAt = timestamp(input.renewedAt, "renewal");
      await this.sweepExpired(renewedAt);
      const row = await this.sql.prepare(`
        UPDATE managed_session_executions
           SET lease_expires_at_ms = CASE
                 WHEN ? < deadline_at_ms THEN ? ELSE deadline_at_ms END,
               revision = revision + 1
         WHERE workspace_id = ? AND id = ? AND session_id = ?
           AND state = 'running' AND attempt_id = ? AND owner_id = ?
           AND generation = ? AND lease_expires_at_ms > ?
           AND deadline_at_ms > ?
        RETURNING ${columns()}
      `).bind(
        renewedAt + input.leaseTtlMs,
        renewedAt + input.leaseTtlMs,
        input.fence.workspaceId,
        input.fence.executionId,
        input.fence.sessionId,
        input.fence.attemptId,
        input.fence.ownerId,
        input.fence.generation,
        renewedAt,
        renewedAt,
      ).first<ExecutionRow>();
      return row === null
        ? { type: "lost" as const }
        : {
            type: "renewed" as const,
            fence: toFence(row),
            interruptRequestedAt: toExecution(row).interruptRequestedAt,
          };
    }),
      catch: (error: unknown) => error,
    }));
  }

  settle(input: {
    fence: SessionExecutionFence;
    settledAt: string;
    outcome: "completed" | "failed" | "cancelled";
    failure?: string;
  }): Promise<SettleSessionExecutionResult> {
    return runCoordinatorPort(Effect.tryPromise({
      try: () => withDbBoundary({
      op: "session_execution.settle",
      sessionId: input.fence.sessionId,
    }, async () => {
      const settledAt = timestamp(input.settledAt, "settlement");
      const row = await this.sql.prepare(`
        UPDATE managed_session_executions
           SET state = CASE
                 WHEN interrupt_requested_at_ms IS NOT NULL THEN 'cancelled'
                 ELSE ?
               END,
               settled_at_ms = ?,
               failure = CASE
                 WHEN interrupt_requested_at_ms IS NOT NULL
                   THEN COALESCE(failure, 'interrupted during execution')
                 ELSE ?
               END,
               revision = revision + 1
         WHERE workspace_id = ? AND id = ? AND session_id = ?
           AND state = 'running' AND attempt_id = ? AND owner_id = ?
           AND generation = ? AND lease_expires_at_ms > ?
        RETURNING ${columns()}
      `).bind(
        input.outcome,
        settledAt,
        input.failure?.slice(0, 4_096) ?? null,
        input.fence.workspaceId,
        input.fence.executionId,
        input.fence.sessionId,
        input.fence.attemptId,
        input.fence.ownerId,
        input.fence.generation,
        settledAt,
      ).first<ExecutionRow>();
      if (row !== null) return { type: "settled" as const, execution: toExecution(row) };
      // A retried settle can observe its own commit: the row is already terminal
      // for this attempt. That is success, not a lost lease.
      const current = await this.find({
        workspaceId: input.fence.workspaceId,
        executionId: input.fence.executionId,
      });
      const settledAtIso = new Date(settledAt).toISOString();
      if (current !== null &&
        current.state !== "queued" && current.state !== "running" &&
        current.settledAt === settledAtIso &&
        current.attempt?.id === input.fence.attemptId &&
        current.attempt.ownerId === input.fence.ownerId &&
        current.attempt.generation === input.fence.generation) {
        return { type: "settled" as const, execution: current };
      }
      return { type: "lost" as const };
    }),
      catch: (error: unknown) => error,
    }));
  }

  async cancelQueued(input: {
    workspaceId: string;
    sessionId: string;
    executionId: string;
    cancelledAt: string;
  }): Promise<
    | { type: "cancelled"; execution: SessionExecution }
    | {
        type: "not_queued";
        reason: "already_processing" | "already_cancelled" | "already_completed" | "not_found";
        execution?: SessionExecution;
      }
  > {
    const cancelledAt = timestamp(input.cancelledAt, "queued cancellation");
    const row = await this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'cancelled', settled_at_ms = ?,
             failure = 'removed from queue', revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND id = ? AND state = 'queued'
      RETURNING ${columns()}
    `).bind(cancelledAt, input.workspaceId, input.sessionId, input.executionId)
      .first<ExecutionRow>();
    if (row !== null) return { type: "cancelled", execution: toExecution(row) };
    const current = await this.sql.prepare(`
      SELECT ${columns()} FROM managed_session_executions
       WHERE workspace_id = ? AND session_id = ? AND id = ?
      LIMIT 1
    `).bind(input.workspaceId, input.sessionId, input.executionId)
      .first<ExecutionRow>();
    if (current === null) return { type: "not_queued", reason: "not_found" };
    const execution = toExecution(current);
    const reason =
      current.state === "running" ? "already_processing" as const
      : current.state === "cancelled" ? "already_cancelled" as const
      : current.state === "completed" ? "already_completed" as const
      : "already_processing" as const;
    return { type: "not_queued", reason, execution };
  }

  async steerQueued(input: {
    workspaceId: string;
    sessionId: string;
    executionId: string;
    steeredAt: string;
  }): Promise<{ type: "steered"; execution: SessionExecution } | { type: "not_queued" }> {
    const steeredAt = timestamp(input.steeredAt, "queued steering");
    const row = await this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'completed', settled_at_ms = ?,
             failure = NULL, revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND id = ? AND state = 'queued'
      RETURNING ${columns()}
    `).bind(steeredAt, input.workspaceId, input.sessionId, input.executionId)
      .first<ExecutionRow>();
    return row === null ? { type: "not_queued" } : { type: "steered", execution: toExecution(row) };
  }

  async requestInterrupt(input: {
    workspaceId: string;
    sessionId: string;
    laneId?: string;
    requestedAt: string;
  }): Promise<{ type: "requested" | "idle" }> {
    const requestedAt = timestamp(input.requestedAt, "interrupt request");
    // Queued executions survive an interrupt (Backchat policy): only the
    // running turn is cancelled, and the lane drains the queue next.
    const expired = this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'cancelled', settled_at_ms = ?,
             interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?),
             failure = 'interrupted after owner lease expired',
             revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'running'
         AND lease_expires_at_ms <= ?
         AND (? IS NULL OR lane_id = ?)
    `).bind(
      requestedAt,
      requestedAt,
      input.workspaceId,
      input.sessionId,
      requestedAt,
      input.laneId ?? null,
      input.laneId ?? null,
    );
    const active = this.sql.prepare(`
      UPDATE managed_session_executions
         SET interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?),
             revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'running'
         AND lease_expires_at_ms > ?
         AND (? IS NULL OR lane_id = ?)
    `).bind(
      requestedAt,
      input.workspaceId,
      input.sessionId,
      requestedAt,
      input.laneId ?? null,
      input.laneId ?? null,
    );
    const results = await this.sql.batch([expired, active]);
    return results.reduce((total, result) => total + result.meta.changes, 0) === 0
      ? { type: "idle" }
      : { type: "requested" };
  }

  async cancelSession(input: {
    workspaceId: string;
    sessionId: string;
    cancelledAt: string;
    reason: string;
  }): Promise<{ queued: number; running: number }> {
    const cancelledAt = timestamp(input.cancelledAt, "session cancellation");
    const queued = this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'cancelled', settled_at_ms = ?, failure = ?,
             revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'queued'
    `).bind(
      cancelledAt,
      input.reason.slice(0, 4_096),
      input.workspaceId,
      input.sessionId,
    );
    const running = this.sql.prepare(`
      UPDATE managed_session_executions
         SET state = 'cancelled', settled_at_ms = ?,
             interrupt_requested_at_ms = COALESCE(interrupt_requested_at_ms, ?),
             failure = ?,
             revision = revision + 1
       WHERE workspace_id = ? AND session_id = ? AND state = 'running'
    `).bind(
      cancelledAt,
      cancelledAt,
      input.reason.slice(0, 4_096),
      input.workspaceId,
      input.sessionId,
    );
    const results = await this.sql.batch([queued, running]);
    const queuedResult = results[0];
    const runningResult = results[1];
    if (queuedResult === undefined || runningResult === undefined) {
      throw new Error("Session cancellation SQL batch must return two results");
    }
    return {
      queued: queuedResult.meta.changes,
      running: runningResult.meta.changes,
    };
  }

  async find(input: {
    workspaceId: string;
    executionId: string;
  }): Promise<SessionExecution | null> {
    const row = await this.sql.prepare(`
      SELECT ${columns()}
        FROM managed_session_executions
       WHERE workspace_id = ? AND id = ?
    `).bind(input.workspaceId, input.executionId).first<ExecutionRow>();
    return row === null ? null : toExecution(row);
  }


  private async sweepExpired(now: number): Promise<void> {
    const interval = this.options.sweepIntervalMs ?? 0;
    if (interval > 0 && now < this.#nextSweepAt) return;
    if (interval > 0) {
      this.#nextSweepAt = now + interval + Math.floor(Math.random() * interval * 2);
    }
    try {
      await withDbBoundary({ op: "session_execution.sweep_expired" }, async () => {
        await this.terminalizeMatching(
          now,
          "execution deadline exceeded",
          "state IN ('queued', 'running') AND deadline_at_ms <= ?",
          [now],
        );
        await this.terminalizeMatching(
          now,
          "execution attempt limit exhausted",
          "state = 'running' AND lease_expires_at_ms <= ? AND attempt_count >= max_attempts",
          [now],
        );
      });
    } catch (error) {
      if (this.options.onError === undefined) throw error;
      this.options.onError(error, "session_execution.sweep_expired");
    }
  }

  private async terminalizeMatching(
    now: number,
    failure: string,
    where: string,
    binds: unknown[],
  ): Promise<void> {
    for (let batch = 0; batch < 20; batch++) {
      const selected = await this.sql.prepare(`
        SELECT workspace_id, id, revision
          FROM managed_session_executions
         WHERE ${where}
         LIMIT 100
      `).bind(...binds).all<{
        workspace_id: string;
        id: string;
        revision: number | string;
      }>();
      const rows = selected.results ?? [];
      if (rows.length === 0) return;
      for (const row of rows) {
        await this.sql.prepare(`
          UPDATE managed_session_executions
             SET state = 'failed', settled_at_ms = ?, failure = ?,
                 revision = revision + 1
           WHERE workspace_id = ? AND id = ? AND revision = ?
             AND ${where}
        `).bind(
          now,
          failure,
          row.workspace_id,
          row.id,
          safeInteger(row.revision, "execution revision"),
          ...binds,
        ).run();
      }
      if (rows.length < 100) return;
    }
  }
}

/** @deprecated Use SqlSessionExecutionStore. */
export const SqlSessionExecutionCoordinator = SqlSessionExecutionStore;
