import type { SqlClient, SqlTransaction } from "@open-managed-agents/sql-client";
import type {
  CancelToolRequestResult,
  CompleteToolRequestResult,
  PollToolRequests,
  PollToolRequestsResult,
  RenewToolRequestResult,
  ToolExecutionConcurrency,
  ToolRequest,
  ToolRequestClaim,
  ToolRequestFence,
  ToolRequestInput,
  ToolRequestResult,
  ToolRequestStorePort,
} from "@open-managed-agents/session-runtime-contract/tool-dispatch";

type SqlToolDispatchDialect = "sqlite" | "postgres" | "mysql";

export interface SqlToolRequestStoreOptions {
  dialect?: SqlToolDispatchDialect;
}

interface ToolRequestRow {
  id: string;
  idempotency_key: string;
  workspace_id: string;
  session_id: string;
  session_thread_id: string | null;
  tool_use_id: string;
  tool_name: string;
  args_json: string;
  concurrency: ToolExecutionConcurrency;
  resource_key: string | null;
  created_at_ms: number | string;
  available_at_ms: number | string;
  state: ToolRequest["state"];
  attempt_count: number | string;
  revision: number | string;
  owner_id: string | null;
  attempt_id: string | null;
  generation: number | string | null;
  claimed_at_ms: number | string | null;
  lease_expires_at_ms: number | string | null;
  result_json: string | null;
  cancelled_at_ms: number | string | null;
}

function numberValue(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: number | string | null): string | null {
  const milliseconds = numberValue(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Invalid ${field} in managed_tool_requests`, { cause: error });
  }
}

function rowToRequest(row: ToolRequestRow): ToolRequest {
  const claim: ToolRequestClaim | null = row.owner_id && row.attempt_id && row.generation !== null &&
    row.claimed_at_ms !== null && row.lease_expires_at_ms !== null
    ? {
        ownerId: row.owner_id,
        attemptId: row.attempt_id,
        generation: Number(row.generation),
        claimedAt: iso(row.claimed_at_ms)!,
        leaseExpiresAt: iso(row.lease_expires_at_ms)!,
      }
    : null;
  const result = row.result_json === null
    ? null
    : parseJson<ToolRequestResult>(row.result_json, "result_json");
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    ...(row.session_thread_id === null ? {} : { sessionThreadId: row.session_thread_id }),
    toolUseId: row.tool_use_id,
    toolName: row.tool_name,
    args: parseJson<unknown>(row.args_json, "args_json"),
    concurrency: row.concurrency,
    ...(row.resource_key === null ? {} : { resourceKey: row.resource_key }),
    createdAt: iso(row.created_at_ms)!,
    availableAt: iso(row.available_at_ms)!,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    revision: Number(row.revision),
    claim,
    result,
    cancelledAt: iso(row.cancelled_at_ms),
  };
}

function fingerprint(input: Pick<ToolRequestInput, "workspaceId" | "sessionId" | "sessionThreadId" | "toolUseId" | "toolName" | "args" | "concurrency" | "resourceKey">): string {
  return JSON.stringify({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sessionThreadId: input.sessionThreadId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    args: input.args,
    concurrency: input.concurrency,
    resourceKey: input.resourceKey,
  });
}

function scopeKey(request: ToolRequest): string {
  return `${request.workspaceId}/${request.sessionId}`;
}

function resourceKey(request: ToolRequest): string {
  return request.resourceKey ?? scopeKey(request);
}

function canClaim(candidate: ToolRequest, active: readonly ToolRequest[]): boolean {
  const candidateScope = scopeKey(candidate);
  const candidateResource = resourceKey(candidate);
  return active.every((request) => {
    if (scopeKey(request) !== candidateScope) return true;
    if (candidate.concurrency === "exclusive" || request.concurrency === "exclusive") return false;
    if (candidate.concurrency === "resource_serial" || request.concurrency === "resource_serial") {
      return resourceKey(request) !== candidateResource;
    }
    return true;
  });
}

function fenceMatches(request: ToolRequest, fence: ToolRequestFence): boolean {
  return request.state === "claimed" && request.claim !== null &&
    request.id === fence.requestId && request.workspaceId === fence.workspaceId &&
    request.sessionId === fence.sessionId && request.claim.ownerId === fence.ownerId &&
    request.claim.attemptId === fence.attemptId && request.claim.generation === fence.generation &&
    request.claim.leaseExpiresAt === fence.expiresAt;
}

function fenceFrom(request: ToolRequest): ToolRequestFence {
  if (request.claim === null) throw new Error("Cannot create a fence for an unclaimed tool request");
  return {
    requestId: request.id,
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    attemptId: request.claim.attemptId,
    ownerId: request.claim.ownerId,
    generation: request.claim.generation,
    expiresAt: request.claim.leaseExpiresAt,
  };
}

function milliseconds(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid timestamp ${value}`);
  return parsed;
}

function sqlNow(value: string): number {
  return milliseconds(value);
}

/** SQL implementation of the dispatcher contract. SQLite/D1 uses atomic
 * compare-and-set updates. PostgreSQL and MySQL use the repository's row-lock
 * transaction port for poll/claim so two workers cannot admit conflicting
 * leases for the same session. */
export class SqlToolRequestStore implements ToolRequestStorePort {
  private readonly dialect: SqlToolDispatchDialect;

  constructor(
    private readonly sql: SqlClient,
    options: SqlToolRequestStoreOptions = {},
  ) {
    this.dialect = options.dialect ?? "sqlite";
  }

  async enqueue(input: ToolRequestInput) {
    const createdAt = milliseconds(input.createdAt);
    const availableAt = milliseconds(input.availableAt ?? input.createdAt);
    const insert = this.dialect === "mysql"
      ? `INSERT IGNORE INTO managed_tool_requests
          (id,idempotency_key,workspace_id,session_id,session_thread_id,tool_use_id,tool_name,args_json,concurrency,resource_key,created_at_ms,available_at_ms,state,attempt_count,revision)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued',0,1)`
      : `INSERT INTO managed_tool_requests
          (id,idempotency_key,workspace_id,session_id,session_thread_id,tool_use_id,tool_name,args_json,concurrency,resource_key,created_at_ms,available_at_ms,state,attempt_count,revision)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued',0,1)
         ON CONFLICT DO NOTHING`;
    const inserted = await this.sql.prepare(insert).bind(
      input.id,
      input.idempotencyKey,
      input.workspaceId,
      input.sessionId,
      input.sessionThreadId ?? null,
      input.toolUseId,
      input.toolName,
      JSON.stringify(input.args),
      input.concurrency,
      input.resourceKey ?? null,
      createdAt,
      availableAt,
    ).run();
    const row = await this.sql.prepare(
      "SELECT * FROM managed_tool_requests WHERE id=? OR idempotency_key=? LIMIT 1",
    ).bind(input.id, input.idempotencyKey).first<ToolRequestRow>();
    if (row === null) throw new Error("Tool request insert was not observable");
    const request = rowToRequest(row);
    if (request.id === input.id && request.idempotencyKey !== input.idempotencyKey) {
      return { type: "conflict" as const, request };
    }
    if (fingerprint(request) !== fingerprint(input)) return { type: "conflict" as const, request };
    return inserted.meta.changes === 1
      ? { type: "enqueued" as const, request }
      : { type: "replayed" as const, request };
  }

  async poll(input: PollToolRequests): Promise<PollToolRequestsResult> {
    const now = sqlNow(input.now);
    if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
      throw new RangeError("leaseTtlMs must be a positive integer");
    }
    const limit = input.limit ?? 1;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("limit must be a positive integer");
    await this.requeueExpired(now);
    if (this.dialect !== "sqlite") {
      const transactions = this.sql.rowLockTransactions;
      if (!transactions) throw new Error("Tool request polling requires row-lock transactions for this SQL dialect");
      const capability = await transactions.capability(["managed_tool_requests"]);
      if (!capability.supported) throw new Error(`Tool request row-lock authority unavailable: ${capability.reason}`);
      return transactions.run((tx) => this.pollLocked(tx, input, now, limit));
    }
    return this.pollSqlite(input, now, limit);
  }

  async renew(input: { fence: ToolRequestFence; renewedAt: string; leaseTtlMs: number }): Promise<RenewToolRequestResult> {
    if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0) {
      throw new RangeError("leaseTtlMs must be a positive integer");
    }
    const renewedAt = sqlNow(input.renewedAt);
    const expiresAt = renewedAt + input.leaseTtlMs;
    const result = await this.sql.prepare(`
      UPDATE managed_tool_requests
      SET lease_expires_at_ms=?, revision=revision+1
      WHERE id=? AND state='claimed' AND workspace_id=? AND session_id=?
        AND owner_id=? AND attempt_id=? AND generation=? AND lease_expires_at_ms=?
        AND lease_expires_at_ms>?
    `).bind(
      expiresAt,
      input.fence.requestId,
      input.fence.workspaceId,
      input.fence.sessionId,
      input.fence.ownerId,
      input.fence.attemptId,
      input.fence.generation,
      milliseconds(input.fence.expiresAt),
      renewedAt,
    ).run();
    if (result.meta.changes !== 1) return { type: "lost" };
    return {
      type: "renewed",
      fence: { ...input.fence, expiresAt: new Date(expiresAt).toISOString() },
    };
  }

  async complete(input: { fence: ToolRequestFence; result: Omit<ToolRequestResult, "idempotencyKey"> }): Promise<CompleteToolRequestResult> {
    const current = await this.find({ requestId: input.fence.requestId });
    if (current === null) return { type: "lost" };
    if (current.state === "completed" && current.result !== null) return { type: "replayed", request: current };
    const completedAt = sqlNow(input.result.completedAt);
    if (!fenceMatches(current, input.fence) || milliseconds(input.fence.expiresAt) <= completedAt) return { type: "lost" };
    const result: ToolRequestResult = { ...input.result, idempotencyKey: current.idempotencyKey };
    const written = await this.sql.prepare(`
      UPDATE managed_tool_requests
      SET state='completed', revision=revision+1, owner_id=NULL, attempt_id=NULL,
          generation=NULL, claimed_at_ms=NULL, lease_expires_at_ms=NULL, result_json=?
      WHERE id=? AND state='claimed' AND workspace_id=? AND session_id=?
        AND owner_id=? AND attempt_id=? AND generation=? AND lease_expires_at_ms=?
        AND lease_expires_at_ms>?
    `).bind(
      JSON.stringify(result),
      input.fence.requestId,
      input.fence.workspaceId,
      input.fence.sessionId,
      input.fence.ownerId,
      input.fence.attemptId,
      input.fence.generation,
      milliseconds(input.fence.expiresAt),
      completedAt,
    ).run();
    if (written.meta.changes !== 1) return { type: "lost" };
    const settled = await this.find({ requestId: input.fence.requestId });
    return settled === null ? { type: "lost" } : { type: "completed", request: settled };
  }

  async cancel(input: { requestId: string; cancelledAt: string; fence?: ToolRequestFence }): Promise<CancelToolRequestResult> {
    const current = await this.find({ requestId: input.requestId });
    if (current === null) return { type: "lost" };
    if (current.state === "completed" || current.state === "cancelled") return { type: "already_settled", request: current };
    const cancelledAt = sqlNow(input.cancelledAt);
    if (current.state === "claimed") {
      if (!input.fence || !fenceMatches(current, input.fence) || milliseconds(input.fence.expiresAt) <= cancelledAt) return { type: "lost" };
    }
    const bindings: unknown[] = [cancelledAt, input.requestId, current.revision];
    let where = "id=? AND revision=? AND state IN ('queued','claimed')";
    if (current.state === "claimed" && input.fence) {
      where += " AND owner_id=? AND attempt_id=? AND generation=? AND lease_expires_at_ms=? AND lease_expires_at_ms>?";
      bindings.push(input.fence.ownerId, input.fence.attemptId, input.fence.generation, milliseconds(input.fence.expiresAt), cancelledAt);
    }
    const result = await this.sql.prepare(`
      UPDATE managed_tool_requests
      SET state='cancelled', cancelled_at_ms=?, revision=revision+1, owner_id=NULL, attempt_id=NULL,
          generation=NULL, claimed_at_ms=NULL, lease_expires_at_ms=NULL
      WHERE ${where}
    `).bind(...bindings).run();
    if (result.meta.changes !== 1) return { type: "lost" };
    const settled = await this.find({ requestId: input.requestId });
    return settled === null ? { type: "lost" } : { type: "cancelled", request: settled };
  }

  async find(input: { requestId: string }): Promise<ToolRequest | null> {
    const row = await this.sql.prepare("SELECT * FROM managed_tool_requests WHERE id=?").bind(input.requestId).first<ToolRequestRow>();
    return row === null ? null : rowToRequest(row);
  }

  private async requeueExpired(now: number, client: SqlClient | SqlTransaction = this.sql): Promise<void> {
    await client.prepare(`
      UPDATE managed_tool_requests
      SET state='queued', revision=revision+1, owner_id=NULL, attempt_id=NULL, generation=NULL,
          claimed_at_ms=NULL, lease_expires_at_ms=NULL, available_at_ms=?
      WHERE state='claimed' AND lease_expires_at_ms<=?
    `).bind(now, now).run();
  }

  private async pollSqlite(input: PollToolRequests, now: number, limit: number): Promise<PollToolRequestsResult> {
    const candidates = await this.selectCandidates(this.sql, input, now, limit * 4);
    const leases: Array<{ request: ToolRequest; fence: ToolRequestFence }> = [];
    for (const candidate of candidates) {
      if (leases.length >= limit) break;
      const generation = candidate.attemptCount + 1;
      const leaseExpires = now + input.leaseTtlMs;
      const conflict = this.conflictPredicate(candidate);
      const updated = await this.sql.prepare(`
        UPDATE managed_tool_requests
        SET state='claimed', attempt_count=attempt_count+1, revision=revision+1,
            owner_id=?, attempt_id=?, generation=?, claimed_at_ms=?, lease_expires_at_ms=?
        WHERE id=? AND state='queued' AND available_at_ms<=?
          AND NOT EXISTS (${conflict.sql})
      `).bind(
        input.workerId,
        `${input.workerId}:${candidate.id}:${generation}`,
        generation,
        now,
        leaseExpires,
        candidate.id,
        now,
        ...conflict.bindings,
      ).run();
      if (updated.meta.changes !== 1) continue;
      const request = await this.find({ requestId: candidate.id });
      if (request?.claim) leases.push({ request, fence: fenceFrom(request) });
    }
    return leases.length === 0 ? { type: "empty" } : { type: "claimed", leases };
  }

  private async pollLocked(tx: SqlTransaction, input: PollToolRequests, now: number, limit: number): Promise<PollToolRequestsResult> {
    const candidates = await this.selectCandidates(tx, input, now, limit * 4, true);
    const leases: Array<{ request: ToolRequest; fence: ToolRequestFence }> = [];
    const activeCache = new Map<string, ToolRequest[]>();
    for (const candidate of candidates) {
      if (leases.length >= limit) break;
      const key = scopeKey(candidate);
      let active = activeCache.get(key);
      if (!active) {
        const rows = await tx.prepare(
          "SELECT * FROM managed_tool_requests WHERE workspace_id=? AND session_id=? AND state='claimed' FOR UPDATE",
        ).bind(candidate.workspaceId, candidate.sessionId).all<ToolRequestRow>();
        active = (rows.results ?? []).map(rowToRequest);
        activeCache.set(key, active);
      }
      if (!canClaim(candidate, active)) continue;
      const generation = candidate.attemptCount + 1;
      const leaseExpires = now + input.leaseTtlMs;
      const updated = await tx.prepare(`
        UPDATE managed_tool_requests
        SET state='claimed', attempt_count=attempt_count+1, revision=revision+1,
            owner_id=?, attempt_id=?, generation=?, claimed_at_ms=?, lease_expires_at_ms=?
        WHERE id=? AND state='queued'
      `).bind(
        input.workerId,
        `${input.workerId}:${candidate.id}:${generation}`,
        generation,
        now,
        leaseExpires,
        candidate.id,
      ).run();
      if (updated.meta.changes !== 1) continue;
      const request = rowToRequest((await tx.prepare("SELECT * FROM managed_tool_requests WHERE id=?").bind(candidate.id).first<ToolRequestRow>())!);
      const fence = fenceFrom(request);
      leases.push({ request, fence });
      active.push(request);
    }
    return leases.length === 0 ? { type: "empty" } : { type: "claimed", leases };
  }

  private async selectCandidates(
    client: SqlClient | SqlTransaction,
    input: PollToolRequests,
    now: number,
    limit: number,
    locked = false,
  ): Promise<ToolRequest[]> {
    const conditions = ["state='queued'", "available_at_ms<=?"];
    const bindings: unknown[] = [now];
    if (input.workspaceId !== undefined) { conditions.push("workspace_id=?"); bindings.push(input.workspaceId); }
    if (input.sessionId !== undefined) { conditions.push("session_id=?"); bindings.push(input.sessionId); }
    if (input.toolNames !== undefined && input.toolNames.length > 0) {
      conditions.push(`tool_name IN (${input.toolNames.map(() => "?").join(",")})`);
      bindings.push(...input.toolNames);
    }
    const lock = locked ? " FOR UPDATE SKIP LOCKED" : "";
    const rows = await client.prepare(
      `SELECT * FROM managed_tool_requests WHERE ${conditions.join(" AND ")} ORDER BY created_at_ms,id LIMIT ?${lock}`,
    ).bind(...bindings, limit).all<ToolRequestRow>();
    return (rows.results ?? []).map(rowToRequest);
  }

  private conflictPredicate(candidate: ToolRequest): { sql: string; bindings: unknown[] } {
    const scope = `${candidate.workspaceId}`;
    const resource = resourceKey(candidate);
    const sql = `
      SELECT 1 FROM managed_tool_requests active
      WHERE active.state='claimed' AND active.workspace_id=? AND active.session_id=?
        AND (active.concurrency='exclusive' OR ?='exclusive'
          OR ((active.concurrency='resource_serial' OR ?='resource_serial')
            AND (active.resource_key=COALESCE(?, active.workspace_id||'/'||active.session_id)
              OR ?=COALESCE(active.resource_key, active.workspace_id||'/'||active.session_id))))`;
    return {
      sql,
      bindings: [candidate.workspaceId, candidate.sessionId, candidate.concurrency, candidate.concurrency, candidate.resourceKey ?? null, resource],
    };
  }
}

export const managedToolRequestSchema = `
CREATE TABLE IF NOT EXISTS managed_tool_requests (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_thread_id TEXT,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  concurrency TEXT NOT NULL,
  resource_key TEXT,
  created_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  owner_id TEXT,
  attempt_id TEXT,
  generation INTEGER,
  claimed_at_ms INTEGER,
  lease_expires_at_ms INTEGER,
  result_json TEXT,
  cancelled_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS managed_tool_requests_poll_idx ON managed_tool_requests(state, available_at_ms, created_at_ms, id);
CREATE INDEX IF NOT EXISTS managed_tool_requests_scope_idx ON managed_tool_requests(workspace_id, session_id, state, lease_expires_at_ms);
`;
