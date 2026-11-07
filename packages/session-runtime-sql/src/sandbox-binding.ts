import type {
  SessionSandboxBindingPort,
  SessionSandboxBindingSnapshot,
  SessionSandboxClaimResult,
  SessionSandboxManagementFence,
  SessionSandboxMutation,
  SessionSandboxMutationResult,
  SessionSandboxResource,
  SessionSandboxScope,
  SessionSandboxUseMutation,
} from "@open-managed-agents/session-runtime-contract/sandbox-binding";
import type { SqlClient, SqlStatement } from "@open-managed-agents/sql-client";

const bindings = "managed_session_sandbox_bindings";
const resources = "managed_session_sandbox_resources";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS ${bindings} (
    workspace_id VARCHAR(191) NOT NULL,
    session_id VARCHAR(191) NOT NULL,
    allocation_id VARCHAR(191),
    revision BIGINT NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    lock_token VARCHAR(191),
    mutation_token VARCHAR(191),
    PRIMARY KEY (workspace_id, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${resources} (
    workspace_id VARCHAR(191) NOT NULL,
    session_id VARCHAR(191) NOT NULL,
    allocation_id VARCHAR(191) NOT NULL,
    provider VARCHAR(191) NOT NULL,
    provider_namespace VARCHAR(191) NOT NULL,
    runtime_id VARCHAR(191),
    handle_json TEXT,
    config_fingerprint TEXT NOT NULL,
    desired_state VARCHAR(32) NOT NULL,
    observed_state VARCHAR(32) NOT NULL,
    readiness VARCHAR(32) NOT NULL,
    management_owner_id VARCHAR(191),
    management_generation BIGINT NOT NULL,
    management_lease_expires_at_ms BIGINT,
    use_execution_id VARCHAR(191),
    use_attempt_id VARCHAR(191),
    use_owner_id VARCHAR(191),
    use_generation BIGINT,
    use_outcome VARCHAR(32),
    failure TEXT,
    retry_at_ms BIGINT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    revision BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, session_id, allocation_id),
    UNIQUE (workspace_id, provider_namespace, runtime_id)
  )`,
] as const;

export const sessionSandboxBindingSqlSchema = `${schemaStatements.join(";\n")};`;

/** VARCHAR primary/unique keys work on all three backends. MySQL needs InnoDB
 * row locks and binary identity comparisons, rather than its database default
 * case-insensitive collation. No dialect-specific RETURNING/CTEs are required. */
export async function ensureSessionSandboxBindingSchema(
  sql: SqlClient,
  dialect?: "sqlite" | "postgres" | "mysql",
): Promise<void> {
  for (const statement of schemaStatements) {
    await sql.exec(statement + (dialect === "mysql"
      ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin"
      : ""));
  }
}

interface ResourceRow {
  workspace_id: string;
  session_id: string;
  allocation_id: string;
  provider: string;
  provider_namespace: string;
  runtime_id: string | null;
  handle_json: string | null;
  config_fingerprint: string;
  desired_state: SessionSandboxResource["desiredState"];
  observed_state: SessionSandboxResource["observedState"];
  readiness: SessionSandboxResource["readiness"];
  management_owner_id: string | null;
  management_generation: number | string;
  management_lease_expires_at_ms: number | string | null;
  use_execution_id: string | null;
  use_attempt_id: string | null;
  use_owner_id: string | null;
  use_generation: number | string | null;
  use_outcome: SessionSandboxResource["useOutcome"];
  failure: string | null;
  retry_at_ms: number | string | null;
  created_at_ms: number | string;
  updated_at_ms: number | string;
  revision: number | string;
}

function timestamp(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Invalid sandbox binding timestamp");
  return ms;
}

function leaseExpiry(now: string, ttl: number): number {
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("Invalid sandbox management lease TTL");
  const expires = timestamp(now) + ttl;
  if (!Number.isSafeInteger(expires) || !Number.isFinite(new Date(expires).getTime())) {
    throw new Error("Invalid sandbox management lease expiry");
  }
  return expires;
}

function iso(value: number | string): string {
  return new Date(Number(value)).toISOString();
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid sandbox binding revision");
}

function validateIdentity(...values: string[]): void {
  if (values.some(value => !value || value.length > 191)) {
    throw new Error("Sandbox identities must contain 1–191 characters");
  }
}

function fromRow(row: ResourceRow): SessionSandboxResource {
  return {
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    allocationId: row.allocation_id,
    provider: row.provider,
    providerNamespace: row.provider_namespace,
    handle: row.handle_json === null ? null : JSON.parse(row.handle_json),
    configFingerprint: row.config_fingerprint,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    readiness: row.readiness,
    management: {
      ownerId: row.management_owner_id,
      generation: Number(row.management_generation),
      leaseExpiresAt: row.management_lease_expires_at_ms === null ? null : iso(row.management_lease_expires_at_ms),
    },
    use: row.use_execution_id === null ? null : {
      executionId: row.use_execution_id,
      attemptId: row.use_attempt_id!,
      ownerId: row.use_owner_id!,
      generation: Number(row.use_generation),
    },
    useOutcome: row.use_outcome,
    failure: row.failure,
    retryAt: row.retry_at_ms === null ? null : iso(row.retry_at_ms),
    createdAt: iso(row.created_at_ms),
    updatedAt: iso(row.updated_at_ms),
    revision: Number(row.revision),
  };
}

function managementFence(resource: SessionSandboxResource): SessionSandboxManagementFence | null {
  if (resource.management.ownerId === null || resource.management.leaseExpiresAt === null) return null;
  return {
    workspaceId: resource.workspaceId,
    sessionId: resource.sessionId,
    allocationId: resource.allocationId,
    ownerId: resource.management.ownerId,
    generation: resource.management.generation,
    expiresAt: resource.management.leaseExpiresAt,
  };
}

interface MutationPlan extends SessionSandboxScope {
  allocationId: string;
  now: string;
  expectedRevision?: number;
  fence?: SessionSandboxManagementFence;
  condition: string;
  conditionArgs?: unknown[];
  assignments: string;
  assignmentArgs?: unknown[];
  currentOnly?: boolean;
  detachedOnly?: boolean;
  detachCurrent?: boolean;
  extraLocks?: SqlStatement[];
}

/** All mutations first lock the same Session binding row. The gate is evaluated
 * after that lock and every subsequent write is conditional on its random token.
 * SqlClient.batch is one short transaction on SQLite, PostgreSQL and InnoDB;
 * zero-row CAS results cannot partially change a pointer/resource pair. Reads
 * returning mutation results are also inside the transaction, so a caller never
 * mistakes a subsequent owner's snapshot for its successful mutation.
 *
 * Resource rows (including deleted tombstones) are never overwritten or removed.
 * A runtimeId cannot be assigned to another incarnation in the same namespace:
 * even a very late provider delete must not target a replacement allocation.
 */
export class SqlSessionSandboxBindingStore implements SessionSandboxBindingPort {
  constructor(private readonly sql: SqlClient) {}

  async closeSession(input: SessionSandboxScope & { now: string }): Promise<void> {
    const token = crypto.randomUUID();
    await this.sql.prepare(`INSERT INTO ${bindings} (workspace_id, session_id, revision)
      VALUES (?, ?, 0) ON CONFLICT (workspace_id, session_id) DO NOTHING`)
      .bind(input.workspaceId, input.sessionId).run();
    await this.sql.batch([
      this.lock(input, token),
      this.sql.prepare(`UPDATE ${bindings} SET closed = 1, allocation_id = NULL, revision = revision + 1
        WHERE workspace_id = ? AND session_id = ?`).bind(input.workspaceId, input.sessionId),
      this.sql.prepare(`UPDATE ${resources} SET desired_state = 'retired', revision = revision + 1,
        updated_at_ms = ? WHERE workspace_id = ? AND session_id = ? AND observed_state <> 'deleted'`)
        .bind(timestamp(input.now), input.workspaceId, input.sessionId),
    ]);
  }

  async getCurrent(scope: SessionSandboxScope): Promise<SessionSandboxBindingSnapshot | null> {
    const row = await this.sql.prepare(`SELECT b.workspace_id AS binding_workspace_id,
      b.session_id AS binding_session_id, b.allocation_id AS binding_allocation_id,
      b.revision AS binding_revision, b.closed AS binding_closed, r.*
      FROM ${bindings} b LEFT JOIN ${resources} r
        ON r.workspace_id = b.workspace_id AND r.session_id = b.session_id
        AND r.allocation_id = b.allocation_id
      WHERE b.workspace_id = ? AND b.session_id = ?`)
      .bind(scope.workspaceId, scope.sessionId)
      .first<ResourceRow & {
        binding_workspace_id: string;
        binding_session_id: string;
        binding_allocation_id: string | null;
        binding_revision: number | string;
        binding_closed: number | string;
      }>();
    if (!row) return null;
    if (row.binding_allocation_id !== null && row.allocation_id === null) {
      throw new Error("Session sandbox binding references a missing allocation");
    }
    return {
      binding: {
        workspaceId: row.binding_workspace_id,
        sessionId: row.binding_session_id,
        allocationId: row.binding_allocation_id,
        revision: Number(row.binding_revision),
        closed: Number(row.binding_closed) === 1,
      },
      resource: row.binding_allocation_id === null ? null : fromRow(row),
    };
  }

  async find(input: SessionSandboxScope & { allocationId: string }): Promise<SessionSandboxResource | null> {
    const row = await this.sql.prepare(`SELECT * FROM ${resources}
      WHERE workspace_id = ? AND session_id = ? AND allocation_id = ?`)
      .bind(input.workspaceId, input.sessionId, input.allocationId).first<ResourceRow>();
    return row ? fromRow(row) : null;
  }

  async list(input: SessionSandboxScope & { includeDeleted?: boolean }): Promise<SessionSandboxResource[]> {
    const rows = await this.sql.prepare(`SELECT * FROM ${resources}
      WHERE workspace_id = ? AND session_id = ?
        ${input.includeDeleted ? "" : "AND observed_state <> 'deleted'"}
      ORDER BY created_at_ms, allocation_id`)
      .bind(input.workspaceId, input.sessionId).all<ResourceRow>();
    return (rows.results ?? []).map(fromRow);
  }

  async listPending(input: Parameters<SessionSandboxBindingPort["listPending"]>[0]): Promise<SessionSandboxResource[]> {
    const now = timestamp(input.now);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid sandbox pending scan limit");
    const rows = await this.sql.prepare(`SELECT * FROM ${resources}
      WHERE observed_state <> 'deleted' AND use_execution_id IS NULL
        ${input.purpose === "delete"
          ? "AND desired_state = 'retired' AND runtime_id IS NOT NULL AND handle_json IS NOT NULL"
          : "AND (desired_state = 'retired' OR observed_state IN ('intent', 'allocated', 'lost'))"}
        AND (management_owner_id IS NULL OR management_lease_expires_at_ms <= ?)
        AND (retry_at_ms IS NULL OR retry_at_ms <= ?)
        ${input.workspaceId === undefined ? "" : "AND workspace_id = ?"}
        ${input.provider === undefined ? "" : "AND provider = ?"}
        ${input.providerNamespace === undefined ? "" : "AND provider_namespace = ?"}
      ORDER BY COALESCE(retry_at_ms, created_at_ms), workspace_id, session_id, allocation_id LIMIT ?`)
      .bind(now, now, ...(input.workspaceId === undefined ? [] : [input.workspaceId]),
        ...(input.provider === undefined ? [] : [input.provider]),
        ...(input.providerNamespace === undefined ? [] : [input.providerNamespace]), limit)
      .all<ResourceRow>();
    return (rows.results ?? []).map(fromRow);
  }

  async createIntent(input: Parameters<SessionSandboxBindingPort["createIntent"]>[0]): ReturnType<SessionSandboxBindingPort["createIntent"]> {
    const namespace = input.providerNamespace ?? input.provider;
    validateIdentity(input.workspaceId, input.sessionId, input.allocationId, input.provider, namespace, input.ownerId);
    const revision = input.expectedBindingRevision ?? 0;
    validateRevision(revision);
    const now = timestamp(input.now);
    const expires = leaseExpiry(input.now, input.leaseTtlMs);
    const token = crypto.randomUUID();
    // An empty revision-0 row is just the durable mutex, not an allocation.
    await this.sql.prepare(`INSERT INTO ${bindings} (workspace_id, session_id, revision)
      VALUES (?, ?, 0) ON CONFLICT (workspace_id, session_id) DO NOTHING`)
      .bind(input.workspaceId, input.sessionId).run();
    const gate = this.gate();
    const gateArgs = [input.workspaceId, input.sessionId, token];
    const results = await this.sql.batch<ResourceRow>([
      this.lock(input, token),
      this.sql.prepare(`UPDATE ${bindings}
        SET allocation_id = ?, revision = revision + 1, mutation_token = ?
        WHERE workspace_id = ? AND session_id = ? AND lock_token = ?
          AND allocation_id IS NULL AND revision = ? AND closed = 0
          AND NOT EXISTS (SELECT 1 FROM ${resources}
            WHERE workspace_id = ? AND session_id = ? AND allocation_id = ?)`)
        .bind(input.allocationId, token, input.workspaceId, input.sessionId, token, revision,
          input.workspaceId, input.sessionId, input.allocationId),
      this.sql.prepare(`INSERT INTO ${resources} (
        workspace_id, session_id, allocation_id, provider, provider_namespace,
        config_fingerprint, desired_state, observed_state, readiness,
        management_owner_id, management_generation, management_lease_expires_at_ms,
        created_at_ms, updated_at_ms, revision)
        SELECT ?, ?, ?, ?, ?, ?, 'active', 'intent', 'none', ?, 1, ?, ?, ?, 1
        WHERE ${gate}`)
        .bind(input.workspaceId, input.sessionId, input.allocationId, input.provider, namespace,
          input.configFingerprint, input.ownerId, expires, now, now, ...gateArgs),
      this.selectGated(input, token),
    ]);
    const row = results.at(-1)?.results?.[0];
    if (!row) return { type: "conflict" };
    const resource = fromRow(row);
    return {
      type: "created",
      binding: { workspaceId: input.workspaceId, sessionId: input.sessionId, allocationId: input.allocationId, revision: revision + 1, closed: false },
      resource,
      fence: managementFence(resource)!,
    };
  }

  async claimManagement(input: Parameters<SessionSandboxBindingPort["claimManagement"]>[0]): Promise<SessionSandboxClaimResult> {
    validateIdentity(input.ownerId);
    const result = await this.mutate({
      ...input,
      condition: "r.observed_state <> 'deleted' AND r.use_execution_id IS NULL AND (r.management_owner_id IS NULL OR r.management_lease_expires_at_ms <= ?)",
      conditionArgs: [timestamp(input.now)],
      assignments: "management_owner_id = ?, management_generation = management_generation + 1, management_lease_expires_at_ms = ?",
      assignmentArgs: [input.ownerId, leaseExpiry(input.now, input.leaseTtlMs)],
    });
    return result.type === "conflict" ? result : { type: "claimed", resource: result.resource, fence: result.fence! };
  }

  renewManagement(input: Parameters<SessionSandboxBindingPort["renewManagement"]>[0]): Promise<SessionSandboxMutationResult> {
    return this.mutate({
      ...input.fence, ...input,
      condition: "r.observed_state <> 'deleted'",
      assignments: "management_lease_expires_at_ms = ?",
      assignmentArgs: [leaseExpiry(input.now, input.leaseTtlMs)],
    });
  }

  releaseManagement(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult> {
    return this.mutate({
      ...input.fence, ...input,
      condition: "r.observed_state <> 'deleted'",
      assignments: "management_owner_id = NULL, management_lease_expires_at_ms = NULL",
    });
  }

  async recordHandle(input: Parameters<SessionSandboxBindingPort["recordHandle"]>[0]): Promise<SessionSandboxMutationResult> {
    validateIdentity(input.handle.provider, input.handle.runtimeId);
    if (input.handle.metadata && Object.values(input.handle.metadata).some(value =>
      value !== null && typeof value !== "string" && typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value)))) {
      throw new Error("Sandbox handle metadata must contain JSON scalars");
    }
    const handleJson = JSON.stringify({
      provider: input.handle.provider,
      runtimeId: input.handle.runtimeId,
      ...(input.handle.metadata === undefined ? {} : {
        metadata: Object.fromEntries(Object.entries(input.handle.metadata).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
      }),
    });
    try {
      return await this.mutate({
        ...input.fence, ...input,
        // Retired intents can still discover their create result for cleanup.
        // A stored handle is immutable, including its connection metadata.
        condition: `r.provider = ? AND r.observed_state <> 'deleted'
          AND (r.runtime_id IS NULL OR r.handle_json = ?)
          AND NOT EXISTS (SELECT 1 FROM ${resources} other
            WHERE other.workspace_id = r.workspace_id
              AND other.provider_namespace = r.provider_namespace AND other.runtime_id = ?
              AND NOT (other.session_id = r.session_id AND other.allocation_id = r.allocation_id))`,
        conditionArgs: [input.handle.provider, handleJson, input.handle.runtimeId],
        assignments: `runtime_id = ?, handle_json = ?,
          observed_state = CASE WHEN observed_state = 'intent' THEN 'allocated' ELSE observed_state END,
          readiness = CASE WHEN readiness = 'none' THEN 'created' ELSE readiness END`,
        assignmentArgs: [input.handle.runtimeId, handleJson],
      });
    } catch (error) {
      // Different Sessions have different mutexes. The namespace/runtime UNIQUE
      // constraint is the final arbiter when they concurrently discover one
      // physical runtime. Convert that confirmed collision to a CAS miss, while
      // preserving unrelated driver errors and their retry classification.
      const collision = await this.sql.prepare(`SELECT 1 FROM ${resources} current_resource
        JOIN ${resources} other ON other.workspace_id = current_resource.workspace_id
          AND other.provider_namespace = current_resource.provider_namespace AND other.runtime_id = ?
        WHERE current_resource.workspace_id = ? AND current_resource.session_id = ? AND current_resource.allocation_id = ?
          AND NOT (other.session_id = current_resource.session_id AND other.allocation_id = current_resource.allocation_id)`)
        .bind(input.handle.runtimeId, input.fence.workspaceId, input.fence.sessionId, input.fence.allocationId)
        .first();
      if (collision) return { type: "conflict" };
      throw error;
    }
  }

  markReady(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult> {
    return this.mutate({
      ...input.fence, ...input, currentOnly: true,
      condition: "r.desired_state = 'active' AND r.runtime_id IS NOT NULL AND r.observed_state IN ('allocated', 'ready')",
      assignments: "observed_state = 'ready', readiness = 'prepared', failure = NULL, retry_at_ms = NULL",
    });
  }

  retire(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult> {
    return this.mutate({
      ...input.fence, ...input, detachCurrent: true,
      condition: "r.observed_state <> 'deleted' AND r.use_execution_id IS NULL",
      assignments: "desired_state = 'retired'",
    });
  }

  beginDelete(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult> {
    return this.mutate({
      ...input.fence, ...input, detachedOnly: true,
      condition: "r.desired_state = 'retired' AND r.observed_state <> 'deleted' AND r.use_execution_id IS NULL",
      assignments: "observed_state = 'deleting', failure = NULL, retry_at_ms = NULL",
    });
  }

  markDeleted(input: SessionSandboxMutation): Promise<SessionSandboxMutationResult> {
    return this.mutate({
      ...input.fence, ...input, detachedOnly: true,
      condition: "r.desired_state = 'retired' AND r.observed_state = 'deleting' AND r.use_execution_id IS NULL",
      assignments: `observed_state = 'deleted', readiness = 'none',
        management_owner_id = NULL, management_lease_expires_at_ms = NULL,
        failure = NULL, retry_at_ms = NULL`,
    });
  }

  recordFailure(input: Parameters<SessionSandboxBindingPort["recordFailure"]>[0]): Promise<SessionSandboxMutationResult> {
    return this.mutate({
      ...input.fence, ...input,
      condition: "r.observed_state <> 'deleted'",
      assignments: `failure = ?, retry_at_ms = ?${input.lost ? ", observed_state = 'lost', readiness = 'none'" : ""}`,
      assignmentArgs: [input.failure, input.retryAt == null ? null : timestamp(input.retryAt)],
    });
  }

  claimUse(input: SessionSandboxUseMutation): Promise<SessionSandboxMutationResult> {
    const fence = input.fence;
    return this.mutate({
      workspaceId: fence.workspaceId, sessionId: fence.sessionId,
      allocationId: input.allocationId, expectedRevision: input.expectedRevision, now: input.now,
      currentOnly: true,
      extraLocks: [this.sql.prepare(`UPDATE managed_session_executions SET revision = revision
        WHERE workspace_id = ? AND id = ?`).bind(fence.workspaceId, fence.executionId)],
      condition: `r.desired_state = 'active' AND r.observed_state = 'ready' AND r.readiness = 'prepared' AND r.runtime_id IS NOT NULL
        AND r.management_owner_id IS NULL AND r.failure IS NULL
        AND (r.use_execution_id IS NULL OR (${this.useMatches()} AND r.use_outcome = 'active'))
        AND EXISTS (SELECT 1 FROM managed_session_executions e
          WHERE e.workspace_id = r.workspace_id AND e.session_id = r.session_id AND e.id = ?
            AND e.state = 'running' AND e.attempt_id = ? AND e.owner_id = ? AND e.generation = ?
            AND e.lease_expires_at_ms > ?)`,
      conditionArgs: [...this.useArgs(input), ...this.useArgs(input), timestamp(input.now)],
      assignments: "use_execution_id = ?, use_attempt_id = ?, use_owner_id = ?, use_generation = ?, use_outcome = 'active'",
      assignmentArgs: this.useArgs(input),
    });
  }

  releaseUse(input: SessionSandboxUseMutation): Promise<SessionSandboxMutationResult> {
    return this.mutateUse(input, "use_execution_id = NULL, use_attempt_id = NULL, use_owner_id = NULL, use_generation = NULL, use_outcome = NULL");
  }

  markUseUnknown(input: SessionSandboxUseMutation): Promise<SessionSandboxMutationResult> {
    return this.mutateUse(input, "use_outcome = 'unknown'");
  }

  private mutateUse(input: SessionSandboxUseMutation, assignments: string): Promise<SessionSandboxMutationResult> {
    return this.mutate({
      workspaceId: input.fence.workspaceId, sessionId: input.fence.sessionId,
      allocationId: input.allocationId, expectedRevision: input.expectedRevision, now: input.now,
      condition: this.useMatches(), conditionArgs: this.useArgs(input), assignments,
    });
  }

  private useMatches(): string {
    return "r.use_execution_id = ? AND r.use_attempt_id = ? AND r.use_owner_id = ? AND r.use_generation = ?";
  }

  private useArgs(input: SessionSandboxUseMutation): unknown[] {
    return [input.fence.executionId, input.fence.attemptId, input.fence.ownerId, input.fence.generation];
  }

  private gate(): string {
    return `EXISTS (SELECT 1 FROM ${bindings} WHERE workspace_id = ? AND session_id = ? AND mutation_token = ?)`;
  }

  private lock(scope: SessionSandboxScope, token: string): SqlStatement {
    return this.sql.prepare(`UPDATE ${bindings} SET lock_token = ?, mutation_token = NULL
      WHERE workspace_id = ? AND session_id = ?`).bind(token, scope.workspaceId, scope.sessionId);
  }

  private selectGated(input: SessionSandboxScope & { allocationId: string }, token: string): SqlStatement {
    return this.sql.prepare(`SELECT * FROM ${resources}
      WHERE workspace_id = ? AND session_id = ? AND allocation_id = ? AND ${this.gate()}`)
      .bind(input.workspaceId, input.sessionId, input.allocationId, input.workspaceId, input.sessionId, token);
  }

  private async mutate(input: MutationPlan): Promise<SessionSandboxMutationResult> {
    validateIdentity(input.workspaceId, input.sessionId, input.allocationId);
    if (input.expectedRevision !== undefined) validateRevision(input.expectedRevision);
    const now = timestamp(input.now);
    const token = crypto.randomUUID();
    const conditions = [input.condition];
    const args = [...(input.conditionArgs ?? [])];
    if (input.expectedRevision !== undefined) {
      conditions.push("r.revision = ?");
      args.push(input.expectedRevision);
    }
    if (input.fence) {
      conditions.push("r.management_owner_id = ? AND r.management_generation = ? AND r.management_lease_expires_at_ms > ?");
      args.push(input.fence.ownerId, input.fence.generation, now);
    }
    const statements = [
      this.lock(input, token),
      ...(input.extraLocks ?? []),
      this.sql.prepare(`UPDATE ${bindings} SET mutation_token = ?
        WHERE workspace_id = ? AND session_id = ? AND lock_token = ?
          ${input.currentOnly ? "AND allocation_id = ?" : ""}
          ${input.detachedOnly ? "AND (allocation_id IS NULL OR allocation_id <> ?)" : ""}
          AND EXISTS (SELECT 1 FROM ${resources} r
            WHERE r.workspace_id = ? AND r.session_id = ? AND r.allocation_id = ?
              AND ${conditions.map(condition => `(${condition})`).join(" AND ")})`)
        .bind(token, input.workspaceId, input.sessionId, token,
          ...(input.currentOnly ? [input.allocationId] : []),
          ...(input.detachedOnly ? [input.allocationId] : []),
          input.workspaceId, input.sessionId, input.allocationId, ...args),
      this.sql.prepare(`UPDATE ${resources} SET ${input.assignments}, revision = revision + 1, updated_at_ms = ?
        WHERE workspace_id = ? AND session_id = ? AND allocation_id = ? AND ${this.gate()}`)
        .bind(...(input.assignmentArgs ?? []), now, input.workspaceId, input.sessionId, input.allocationId,
          input.workspaceId, input.sessionId, token),
    ];
    if (input.detachCurrent) {
      statements.push(this.sql.prepare(`UPDATE ${bindings} SET allocation_id = NULL, revision = revision + 1
        WHERE workspace_id = ? AND session_id = ? AND allocation_id = ? AND mutation_token = ?`)
        .bind(input.workspaceId, input.sessionId, input.allocationId, token));
    }
    statements.push(this.selectGated(input, token));
    const results = await this.sql.batch<ResourceRow>(statements);
    const row = results.at(-1)?.results?.[0];
    if (!row) return { type: "conflict" };
    const resource = fromRow(row);
    return { type: "updated", resource, fence: managementFence(resource) };
  }
}
