// SandboxTokenStore over one SqlClient (CF tenant D1, Node SQLite / PG /
// MySQL). The token hashes are a JSON array on the execution row
// (managed_session_executions.sandbox_token_hashes), one current entry:
// {"h": <sha256 hex of the random part>, "s": "all" | "egress"}.
// The scope sits beside the hash so the one find read returns hash, lease
// and scope together. Claim, requeue, settle
// and interrupt-finalize reset it to NULL in the same statement that changes
// the attempt, so a token never outlives its attempt.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SandboxTokenAttempt, SandboxTokenSession, SandboxTokenStore } from "@open-managed-agents/sandbox-gateway";

const REPLACE_RETRIES = 8;

export interface SessionRow {
  id: string; workspace_id: string; document: string; archived_at: number | string | null;
  environment_id: string | null; agent_id: string | null; agent_version: number | string | null;
}
interface FoundRow extends SessionRow {
  execution_id: string | null; attempt_id: string | null; owner_id: string | null; generation: number | string | null;
  claimed_at_ms: number | string | null; lease_expires_at_ms: number | string | null; sandbox_token_hashes: string | null;
}

export function sessionOf(row: SessionRow): SandboxTokenSession {
  const document = JSON.parse(row.document) as {
    environmentId?: string; vaultIds?: string[]; agent?: { id?: string; version?: number; skills?: Array<{ skillId: string; version: string }> };
    resources?: Array<{ type: string; fileId?: string; memoryStoreId?: string; access?: string }>;
  };
  const resources = document.resources ?? [];
  return {
    workspaceId: row.workspace_id, sessionId: row.id,
    archivedAt: row.archived_at === null ? null : new Date(Number(row.archived_at)).toISOString(),
    // The row's own columns are authoritative; older documents may omit these.
    environmentId: row.environment_id ?? document.environmentId ?? "", vaultIds: document.vaultIds ?? [],
    agent: { id: row.agent_id ?? document.agent?.id ?? "", version: Number(row.agent_version ?? document.agent?.version ?? 0) },
    skills: (document.agent?.skills ?? []).map((skill) => ({ skillId: skill.skillId, version: skill.version })),
    fileIds: resources.filter((resource) => resource.type === "file" && resource.fileId).map((resource) => resource.fileId!),
    memoryStores: resources.filter((resource) => resource.type === "memory_store" && resource.memoryStoreId).map((resource) => ({
      memoryStoreId: resource.memoryStoreId!, access: resource.access === "read_only" ? "read_only" as const : "read_write" as const,
    })),
  };
}

/** One stored token. `scope` is kept as read: a missing or unknown value is
 * rejected by the authority (sandboxTokenScopeAdmits), never defaulted. */
export interface TokenEntry { hash: string; scope: unknown }

export const entries = (raw: string | null): TokenEntry[] => {
  if (raw === null || raw === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  // Anything that is not {h, s} is kept with no scope: it never verifies,
  // and a replacement beside it is a scope mismatch (fails closed, nothing rewritten).
  return parsed.map((value): TokenEntry => {
    if (typeof value === "string") return { hash: value, scope: undefined };
    if (typeof value !== "object" || value === null) return { hash: "", scope: undefined };
    const { h, s } = value as { h?: unknown; s?: unknown };
    return { hash: typeof h === "string" ? h : "", scope: s };
  });
};

export const serialize = (list: readonly TokenEntry[]) => JSON.stringify(list.map((entry) => ({ h: entry.hash, s: entry.scope })));

export function createSqlSandboxTokenStore(sql: SqlClient): SandboxTokenStore {
  return {
    // One statement: Session row + the running attempt holding the hash.
    // LIKE narrows by the first 32 hex chars (hex only, nothing to escape;
    // D1 refuses LIKE patterns over 50 bytes, so not the full 64); the JS
    // check below confirms an exact element. Sessions are keyed by id alone.
    async find({ sessionId, tokenSha256 }) {
      const row = await sql.prepare(
        `SELECT s.id, s.workspace_id, s.document, s.archived_at, s.environment_id, s.agent_id, s.agent_version,
                e.id AS execution_id, e.attempt_id, e.owner_id, e.generation,
                e.claimed_at_ms, e.lease_expires_at_ms, e.sandbox_token_hashes
           FROM managed_sessions s
           LEFT JOIN managed_session_executions e
             ON e.workspace_id = s.workspace_id AND e.session_id = s.id
            AND e.state = 'running' AND e.sandbox_token_hashes LIKE ?
          WHERE s.id = ?`,
      ).bind(`%"${tokenSha256.slice(0, 32)}%`, sessionId).first<FoundRow>();
      if (row === null) return null;
      const session = sessionOf(row);
      const entry = entries(row.sandbox_token_hashes).find((candidate) => candidate.hash === tokenSha256);
      const attempt: SandboxTokenAttempt | null = row.execution_id !== null && row.attempt_id !== null && row.owner_id !== null
        && row.generation !== null && row.claimed_at_ms !== null && row.lease_expires_at_ms !== null && entry !== undefined
        ? {
            executionId: row.execution_id, attemptId: row.attempt_id, ownerId: row.owner_id, generation: Number(row.generation),
            claimedAtMs: Number(row.claimed_at_ms), leaseExpiresAtMs: Number(row.lease_expires_at_ms), tokenScope: entry.scope,
          }
        : null;
      return { session, attempt };
    },
    async findSession({ workspaceId, sessionId }) {
      const row = await sql.prepare(
        "SELECT id, workspace_id, document, archived_at, environment_id, agent_id, agent_version FROM managed_sessions WHERE workspace_id = ? AND id = ?",
      ).bind(workspaceId, sessionId).first<SessionRow>();
      return row === null ? null : sessionOf(row);
    },
    // Compare-and-set replaces the complete column with one hash. A concurrent
    // rotation makes this write retry; old hashes never survive a commit. The fence and lease are in the
    // WHERE clause, so a settle / take-over committed first makes it stale.
    async replaceTokenHash({ fence, tokenSha256, scope, nowMs }) {
      for (let attempt = 0; attempt < REPLACE_RETRIES; attempt++) {
        const current = await sql.prepare(
          `SELECT sandbox_token_hashes FROM managed_session_executions
            WHERE workspace_id = ? AND id = ? AND session_id = ? AND state = 'running'
              AND attempt_id = ? AND owner_id = ? AND generation = ? AND lease_expires_at_ms > ?`,
        ).bind(fence.workspaceId, fence.executionId, fence.sessionId, fence.attemptId, fence.ownerId, fence.generation, nowMs)
          .first<{ sandbox_token_hashes: string | null }>();
        if (current === null) return "stale";
        const set = entries(current.sandbox_token_hashes);
        // One attempt, one harness placement: a re-sign keeps the scope.
        if (set.some((entry) => entry.scope !== scope)) return "scope_mismatch";
        if (set.some((entry) => entry.hash === tokenSha256)) return "replaced";
        const result = await sql.prepare(
          `UPDATE managed_session_executions SET sandbox_token_hashes = ?
            WHERE workspace_id = ? AND id = ? AND session_id = ? AND state = 'running'
              AND attempt_id = ? AND owner_id = ? AND generation = ? AND lease_expires_at_ms > ?
              AND COALESCE(sandbox_token_hashes, '') = ?`,
        ).bind(serialize([{ hash: tokenSha256, scope }]), fence.workspaceId, fence.executionId, fence.sessionId,
          fence.attemptId, fence.ownerId, fence.generation, nowMs, current.sandbox_token_hashes ?? "").run();
        if (result.meta.changes === 1) return "replaced";
      }
      throw new Error("Sandbox token replacement kept conflicting");
    },
  };
}
