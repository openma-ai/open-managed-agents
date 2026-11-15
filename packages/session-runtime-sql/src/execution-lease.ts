// SQL reader for the Session execution lease (design §0.0 rule 10): the
// current attempt row in managed_session_executions, written by
// SqlSessionExecutionCoordinator. Read-only; the shared checks live in
// @open-managed-agents/session-runtime/execution-lease.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionExecutionLeases } from "@open-managed-agents/session-runtime/execution-lease";

interface LeaseRow {
  id: string;
  session_id: string;
  state: string;
  attempt_id: string | null;
  owner_id: string | null;
  generation: number | string | null;
  claimed_at_ms: number | string | null;
  lease_expires_at_ms: number | string | null;
}

const num = (value: number | string | null): number | null => value === null ? null : Number(value);

export function createSqlSessionExecutionLeases(sql: SqlClient): SessionExecutionLeases {
  return {
    async find(input) {
      const row = await sql.prepare(
        `SELECT id, session_id, state, attempt_id, owner_id, generation, claimed_at_ms, lease_expires_at_ms
           FROM managed_session_executions
          WHERE workspace_id = ? AND id = ?`,
      ).bind(input.workspaceId, input.executionId).first<LeaseRow>();
      if (row === null) return null;
      return {
        executionId: row.id,
        sessionId: row.session_id,
        state: row.state,
        attemptId: row.attempt_id,
        ownerId: row.owner_id,
        generation: num(row.generation),
        claimedAtMs: num(row.claimed_at_ms),
        leaseExpiresAtMs: num(row.lease_expires_at_ms),
      };
    },
  };
}
