import { log } from "@open-managed-agents/shared";
export { backfillWorkPublications } from "./work-publication-backfill";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  ClaimAvailableEnvironmentWork,
  ClaimAvailableEnvironmentWorkResult,
  EnvironmentWorkLocation,
  EnvironmentWorkStore,
  EnvironmentWorkQueueStats,
  GetEnvironmentWorkQueueStatsRecord,
  FindActiveEnvironmentSessionWork,
  InsertEnvironmentWorkRecord,
  ListEnvironmentWorkRecords,
  ReplaceEnvironmentWorkRecord,
  ReplaceEnvironmentWorkRecordResult,
  StoredEnvironmentWork,
} from "@open-managed-agents/environment-work-store";

export {
  SqlEnvironmentWorkClaimPort,
  type EnvironmentWorkDatabase,
  type SqlEnvironmentWorkClaimOptions,
} from "./work-claim";

export interface EnvironmentWorkSecretCipher {
  seal(input: { plaintext: string }): Promise<{ ciphertext: string }>;
  open(input: { ciphertext: string }): Promise<{ plaintext: string }>;
}

interface EnvironmentWorkRow {
  id: string;
  document: string;
  sealed_secret: string;
  claim_at: number | null;
  claim_worker_id: string | null;
  claim_generation: number;
  heartbeat_ttl_seconds: number;
  revision: number;
  state: StoredEnvironmentWork["work"]["state"];
  created_at: number;
}

interface EnvironmentWorkStatsRow {
  depth: number;
  pending: number;
  oldest_queued_at: number | null;
}

interface EnvironmentWorkWorkerStatsRow {
  active: number;
  total: number;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Environment Work timestamp: ${value}`);
  }
  return milliseconds;
}

export class SqlEnvironmentWorkStore
  implements EnvironmentWorkStore
{
  constructor(
    private readonly client: SqlClient,
    private readonly cipher: EnvironmentWorkSecretCipher,
  ) {}

  private async toStored(row: EnvironmentWorkRow): Promise<StoredEnvironmentWork> {
    const document = JSON.parse(row.document) as StoredEnvironmentWork["work"];
    const work = row.state === "queued"
      ? {
          ...document,
          acknowledgedAt: null,
          latestHeartbeatAt: null,
          startedAt: null,
          state: "queued" as const,
        }
      : { ...document, state: row.state };
    const opened = await this.cipher.open({ ciphertext: row.sealed_secret });
    const secret = JSON.parse(opened.plaintext) as StoredEnvironmentWork["secret"];
    return {
      work: {
        ...work,
        id: row.id,
        createdAt: new Date(Number(row.created_at)).toISOString(),
      },
      secret,
      claim:
        row.claim_at === null || row.state === "stopped"
          ? null
          : {
              claimedAt: new Date(Number(row.claim_at)).toISOString(),
              workerId: row.claim_worker_id,
              generation: Number(row.claim_generation),
            },
      heartbeatTtlSeconds: Number(row.heartbeat_ttl_seconds),
      revision: Number(row.revision),
    };
  }

  private columns(): string {
    return `id, document, sealed_secret, claim_at, claim_worker_id, claim_generation,
            heartbeat_ttl_seconds, revision, state, created_at`;
  }

  async ensureSession(input: InsertEnvironmentWorkRecord): Promise<StoredEnvironmentWork> {
    const { work, secret, claim, heartbeatTtlSeconds } = input.record;
    if (work.data.type !== "session" || work.state !== "queued" || claim !== null) {
      throw new Error("Session ensure requires a fresh queued Work");
    }
    const sealed = await this.cipher.seal({ plaintext: JSON.stringify(secret) });
    for (let attempt = 0; attempt < 10; attempt++) {
      const session = await this.client.prepare("SELECT revision, document FROM managed_sessions WHERE workspace_id = ? AND id = ?")
        .bind(input.workspaceId, work.data.id).first<{ revision: number; document: string }>();
      if (!session) throw new Error("Session not found while ensuring Work");
      if (input.expectedSessionRevision !== undefined && Number(session.revision) !== input.expectedSessionRevision) {
        throw new Error("Session Work recovery snapshot changed");
      }
      const document = JSON.parse(session.document) as { environmentId: string; archivedAt: string | null };
      if (document.archivedAt !== null || document.environmentId !== work.environmentId) throw new Error("Session cannot accept Work in this environment");
      const recoveryRows: Array<{ id: string; document: string }> = [];
      for (const id of input.recoveryEventIds ?? []) {
        const row = await this.client.prepare("SELECT document FROM managed_session_events WHERE workspace_id = ? AND session_id = ? AND id = ?")
          .bind(input.workspaceId, work.data.id, id).first<{ document: string }>();
        if (!row) throw new Error("Recovery input disappeared");
        const event = JSON.parse(row.document);
        if (event.source_position?.consumed_by_execution_id || event.cancelled_at_ms != null || event.deferredUntilToolResults?.length
          || (["user.message", "system.message", "user.tool_confirmation"].includes(event.type) && event.processedAt !== null)) {
          throw new Error("Recovery input was consumed or is not executable");
        }
        recoveryRows.push({ id, document: row.document });
      }
      const conflict = new Error("Session changed while ensuring Work");
      try {
        // Match runtime projection: lock the source revision, gate every write,
        // then advance it. D1 runs the batch in one atomic SQLite snapshot;
        // Node additionally validates before commit under READ COMMITTED.
        const statements = [
          this.client.prepare("UPDATE managed_sessions SET revision = revision WHERE workspace_id = ? AND id = ? AND revision = ?")
            .bind(input.workspaceId, work.data.id, Number(session.revision)),
          this.client.prepare(
            `INSERT INTO managed_environment_work
              (workspace_id, environment_id, id, session_id, document, sealed_secret,
               claim_at, claim_worker_id, claim_generation, heartbeat_ttl_seconds, revision, state, created_at)
             SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, 1, 'queued', ?
             WHERE NOT EXISTS (SELECT 1 FROM managed_environment_work
               WHERE workspace_id = ? AND session_id = ? AND state IN ('queued', 'starting', 'active'))
               AND EXISTS (SELECT 1 FROM managed_sessions WHERE workspace_id = ? AND id = ? AND revision = ?)`
          ).bind(input.workspaceId, work.environmentId, work.id, work.data.id, JSON.stringify(work), sealed.ciphertext,
            heartbeatTtlSeconds, timestamp(work.createdAt), input.workspaceId, work.data.id,
            input.workspaceId, work.data.id, Number(session.revision)),
          this.client.prepare(`SELECT ${this.columns()} FROM managed_environment_work
            WHERE workspace_id = ? AND session_id = ? AND state IN ('queued', 'starting', 'active')`)
            .bind(input.workspaceId, work.data.id),
          this.client.prepare(
            "UPDATE managed_sessions SET revision = revision + 1 WHERE workspace_id = ? AND id = ? AND revision = ? " +
            "AND (SELECT count(*) FROM managed_environment_work WHERE workspace_id = ? AND session_id = ? AND state IN ('queued', 'starting', 'active')) = 1 " +
            "AND EXISTS (SELECT 1 FROM managed_environment_work WHERE workspace_id = ? AND session_id = ? AND environment_id = ? AND state IN ('queued', 'starting', 'active'))"
          ).bind(input.workspaceId, work.data.id, Number(session.revision), input.workspaceId, work.data.id,
            input.workspaceId, work.data.id, work.environmentId),
        ];
        const eventGuards = recoveryRows.map(row => this.client.prepare(
          "UPDATE managed_session_events SET document = document WHERE workspace_id = ? AND session_id = ? AND id = ? AND document = ?"
        ).bind(input.workspaceId, work.data.id, row.id, row.document));
        // Lock consumption facts before the Session CAS: markProcessed uses a
        // document CAS without advancing Session revision. Unknown effects must
        // not race recovery into another consumer.
        const recoveryStatements = eventGuards.flatMap(statement => this.client.batchChecked ? [statement] : [statement,
          this.client.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE abs(-9223372036854775808) END")]);
        const validate = (results: import("@open-managed-agents/sql-client").SqlRunResult<EnvironmentWorkRow>[]) => {
          const rows = results[2]?.results ?? [];
          if (rows.length > 1) throw new Error("Session has ambiguous consumable Work");
          if (results[3]?.meta.changes !== 1 || rows.length !== 1) throw conflict;
          const selected = JSON.parse(rows[0]!.document) as StoredEnvironmentWork["work"];
          if (selected.environmentId !== work.environmentId) throw new Error("Session Work environment mismatch");
        };
        const results = this.client.batchChecked
          ? (await this.client.batchChecked<EnvironmentWorkRow>([...recoveryStatements, ...statements], results => {
              if (results.slice(0, eventGuards.length).some(row => row.meta.changes !== 1)) throw conflict;
              validate(results.slice(eventGuards.length));
            })).slice(eventGuards.length)
          : (await this.client.batch<EnvironmentWorkRow>([...recoveryStatements, ...statements,
            // D1 has no JS callback before COMMIT. A SQL assertion must fail
            // inside its atomic batch, not validate a partial commit afterward.
            // SQLite abs(INT64_MIN) raises integer overflow (never returns NULL).
            this.client.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE abs(-9223372036854775808) END"),
          ])).slice(recoveryStatements.length);
        validate(results);
        const stored = await this.toStored(results[2]!.results![0]!);
        log({ op: "work.enqueue", tenant_id: input.workspaceId, environment_id: stored.work.environmentId, work_id: stored.work.id, session_id: stored.work.data.type === "session" ? stored.work.data.id : undefined, enqueued_at: stored.work.createdAt, state: stored.work.state, claim_generation: stored.claim?.generation ?? 0 }, "Session Work ensured");
        return stored;
      } catch (error) {
        if (input.expectedSessionRevision !== undefined) throw error;
        if (error === conflict) continue;
        // A D1 assertion rolls the batch back. Retry only a demonstrated
        // source revision race; arbitrary SQL/unknown failures are not replayed.
        if (!this.client.batchChecked && error instanceof Error && error.message.includes("integer overflow")) {
          const latest = await this.client.prepare("SELECT revision FROM managed_sessions WHERE workspace_id = ? AND id = ?")
            .bind(input.workspaceId, work.data.id).first<{ revision: number }>();
          if (latest && Number(latest.revision) !== Number(session.revision)) continue;
        }
        throw error;
      }
    }
    throw new Error("Session changed concurrently while ensuring Work");
  }

  async insert(
    input: InsertEnvironmentWorkRecord,
  ): Promise<StoredEnvironmentWork> {
    const record = input.record;
    const sealed = await this.cipher.seal({
      plaintext: JSON.stringify(record.secret),
    });
    const result = await this.client
      .prepare(
        `INSERT INTO managed_environment_work
          (workspace_id, environment_id, id, session_id, document, sealed_secret,
           claim_at, claim_worker_id, claim_generation, heartbeat_ttl_seconds,
           revision, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.workspaceId,
        record.work.environmentId,
        record.work.id,
        record.work.data.type === "session" ? record.work.data.id : null,
        JSON.stringify(record.work),
        sealed.ciphertext,
        record.claim === null ? null : timestamp(record.claim.claimedAt),
        record.claim?.workerId ?? null,
        record.claim?.generation ?? 0,
        record.heartbeatTtlSeconds,
        1,
        record.work.state,
        timestamp(record.work.createdAt),
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(
        `Environment Work insertion affected ${result.meta.changes} rows`,
      );
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      environmentId: record.work.environmentId,
      workId: record.work.id,
    });
    if (inserted === null) throw new Error("Environment Work vanished after insert");
    return inserted;
  }

  async find(
    input: EnvironmentWorkLocation,
  ): Promise<StoredEnvironmentWork | null> {
    const row = await this.client
      .prepare(
        `SELECT ${this.columns()}
           FROM managed_environment_work
          WHERE workspace_id = ? AND environment_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.environmentId, input.workId)
      .first<EnvironmentWorkRow>();
    return row === null ? null : this.toStored(row);
  }

  async findActiveSession(
    input: FindActiveEnvironmentSessionWork,
  ): Promise<StoredEnvironmentWork | null> {
    const row = await this.client
      .prepare(
        `SELECT ${this.columns()}
           FROM managed_environment_work
          WHERE workspace_id = ? AND session_id = ? AND state <> 'stopped'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .bind(input.workspaceId, input.sessionId)
      .first<EnvironmentWorkRow>();
    return row === null ? null : this.toStored(row);
  }

  async list(
    input: ListEnvironmentWorkRecords,
  ): Promise<StoredEnvironmentWork[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Environment Work list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?", "environment_id = ?"];
    const parameters: Array<string | number> = [
      input.workspaceId,
      input.environmentId,
    ];
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(createdAt, createdAt, input.position.workId);
    }
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT ${this.columns()}
           FROM managed_environment_work
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<EnvironmentWorkRow>();
    return Promise.all((rows.results ?? []).map((row) => this.toStored(row)));
  }

  async replace(
    input: ReplaceEnvironmentWorkRecord,
  ): Promise<ReplaceEnvironmentWorkRecordResult> {
    if (
      input.next.work.id !== input.workId ||
      input.next.work.environmentId !== input.environmentId
    ) {
      throw new Error("Replacement Environment Work identity does not match its target");
    }
    const sealed = await this.cipher.seal({
      plaintext: JSON.stringify(input.next.secret),
    });
    const result = await this.client
      .prepare(
        `UPDATE managed_environment_work
            SET document = ?, session_id = ?, sealed_secret = ?,
                claim_at = CASE WHEN ? = 'stopped' THEN COALESCE(?, claim_at) ELSE ? END,
                claim_worker_id = ?, claim_generation = COALESCE(?, claim_generation), heartbeat_ttl_seconds = ?,
                revision = revision + 1, state = ?
          WHERE workspace_id = ? AND environment_id = ? AND id = ?
            AND revision = ?`,
      )
      .bind(
        JSON.stringify(input.next.work),
        input.next.work.data.type === "session"
          ? input.next.work.data.id
          : null,
        sealed.ciphertext,
        input.next.work.state,
        input.next.claim === null ? null : timestamp(input.next.claim.claimedAt),
        input.next.claim === null
          ? null
          : timestamp(input.next.claim.claimedAt),
        input.next.claim?.workerId ?? null,
        input.next.claim?.generation ?? null,
        input.next.heartbeatTtlSeconds,
        input.next.work.state,
        input.workspaceId,
        input.environmentId,
        input.workId,
        input.expectedRevision,
      )
      .run();
    if (result.meta.changes === 0) {
      const current = await this.find(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(
        `Environment Work replacement affected ${result.meta.changes} rows`,
      );
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Environment Work vanished after replace");
    return { type: "replaced", record };
  }

  async claimAvailable(
    input: ClaimAvailableEnvironmentWork,
  ): Promise<ClaimAvailableEnvironmentWorkResult> {
    const claimedAt = timestamp(input.claimedAt);
    const context = { tenant_id: input.workspaceId, environment_id: input.environmentId, worker_id: input.workerId, call_id: crypto.randomUUID(), claimed_at: input.claimedAt, reclaim_before: input.reclaimBefore, heartbeat_ttl_seconds: input.heartbeatTtlSeconds };
    log({ ...context, op: "work.claim.attempt", filter: "queued and unclaimed/reclaim_before; starting/active and lease expired", order: "COALESCE(claim_at, created_at) ASC, created_at ASC, id ASC" }, "Atomic Work claim attempt");
    if (input.workerId !== null) {
      await this.client
        .prepare(
          `INSERT INTO managed_environment_work_workers
            (workspace_id, environment_id, worker_id, last_polled_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (workspace_id, environment_id, worker_id)
           DO UPDATE SET last_polled_at = excluded.last_polled_at`,
        )
        .bind(
          input.workspaceId,
          input.environmentId,
          input.workerId,
          claimedAt,
        )
        .run();
    }
    const rows = await this.client
      .prepare(
        `UPDATE managed_environment_work
            SET claim_at = ?, claim_worker_id = ?,
                claim_generation = claim_generation + 1,
                -- A claim's sandbox tokens never outlive it (ADR 0005).
                sandbox_token_hashes = NULL,
                heartbeat_ttl_seconds = ?,
                state = 'queued',
                revision = revision + 1
          WHERE workspace_id = ? AND environment_id = ?
            AND id = (
              SELECT id
                FROM managed_environment_work
               WHERE workspace_id = ? AND environment_id = ?
                 AND (
                   (state = 'queued' AND (claim_at IS NULL OR claim_at <= ?))
                   OR (
                     state IN ('starting', 'active')
                     AND claim_at IS NOT NULL
                     AND claim_at + heartbeat_ttl_seconds * 1000 <= ?
                   )
                 )
               -- A failed delivery retains its reservation. Order retries by
               -- their last claim, so an old failing item cannot monopolize
               -- every wake ahead of Work that has never been offered.
               ORDER BY COALESCE(claim_at, created_at) ASC, created_at ASC, id ASC
               LIMIT 1
            )
            AND (
              (state = 'queued' AND (claim_at IS NULL OR claim_at <= ?))
              OR (
                state IN ('starting', 'active')
                AND claim_at IS NOT NULL
                AND claim_at + heartbeat_ttl_seconds * 1000 <= ?
              )
            )
          RETURNING ${this.columns()}`,
      )
      .bind(
        claimedAt,
        input.workerId,
        input.heartbeatTtlSeconds,
        input.workspaceId,
        input.environmentId,
        input.workspaceId,
        input.environmentId,
        timestamp(input.reclaimBefore),
        claimedAt,
        timestamp(input.reclaimBefore),
        claimedAt,
      )
      .all<EnvironmentWorkRow>();
    const row = rows.results?.[0];
    if (row === undefined) {
      log({ ...context, op: "work.claim.skipped", reason: "no_row_matching_atomic_eligibility_filter" }, "No eligible Work claim");
      return { type: "empty" };
    }
    const record = await this.toStored(row);
    log({ ...context, op: record.claim!.generation > 1 ? "work.claim.reclaimed" : "work.claim.acquired", work_id: record.work.id, session_id: record.work.data.type === "session" ? record.work.data.id : undefined, claim_generation: record.claim!.generation, enqueued_at: record.work.createdAt }, "Work reservation acquired; ACK still required");
    return { type: "claimed", record };
  }

  async queueStats(
    input: GetEnvironmentWorkQueueStatsRecord,
  ): Promise<EnvironmentWorkQueueStats> {
    const stats = await this.client
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'queued' AND claim_at IS NULL THEN 1 ELSE 0 END) AS depth,
           SUM(CASE WHEN state = 'queued' AND claim_at IS NOT NULL THEN 1 ELSE 0 END) AS pending,
           MIN(CASE WHEN state = 'queued' THEN created_at ELSE NULL END) AS oldest_queued_at
         FROM managed_environment_work
         WHERE workspace_id = ? AND environment_id = ?`,
      )
      .bind(input.workspaceId, input.environmentId)
      .first<EnvironmentWorkStatsRow>();
    const workers = await this.client
      .prepare(
        `SELECT
           SUM(CASE WHEN last_polled_at >= ? THEN 1 ELSE 0 END) AS active,
           COUNT(*) AS total
         FROM managed_environment_work_workers
         WHERE workspace_id = ? AND environment_id = ?`,
      )
      .bind(
        timestamp(input.workerActiveSince),
        input.workspaceId,
        input.environmentId,
      )
      .first<EnvironmentWorkWorkerStatsRow>();
    const totalWorkers = Number(workers?.total ?? 0);
    return {
      depth: Number(stats?.depth ?? 0),
      oldestQueuedAt:
        stats?.oldest_queued_at == null
          ? null
          : new Date(Number(stats.oldest_queued_at)).toISOString(),
      pending: Number(stats?.pending ?? 0),
      workersPolling:
        totalWorkers === 0 ? null : Number(workers?.active ?? 0),
    };
  }
}
