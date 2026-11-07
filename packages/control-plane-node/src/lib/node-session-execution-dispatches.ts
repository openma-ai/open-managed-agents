import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";

/** Evidence of entering business execution, committed before a harness (also
 * opaque/native harnesses) can dispatch an effect. This is not a scheduler or
 * another execution lease. Missing output never proves an operation was absent. */
export class NodeSessionExecutionDispatches {
  constructor(private readonly sql: SqlClient, private readonly now: () => Date = () => new Date()) {}

  async ensureSchema(dialect: "sqlite" | "postgres" | "mysql"): Promise<void> {
    const suffix = dialect === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin" : "";
    await this.sql.exec(`CREATE TABLE IF NOT EXISTS managed_session_dispatch_guards (
      workspace_id VARCHAR(191) NOT NULL, session_id VARCHAR(191) NOT NULL,
      revision BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (workspace_id, session_id)
    )${suffix}`);
    await this.sql.exec(`CREATE TABLE IF NOT EXISTS managed_session_execution_dispatches (
      workspace_id VARCHAR(191) NOT NULL, session_id VARCHAR(191) NOT NULL,
      execution_id VARCHAR(191) NOT NULL, attempt_id VARCHAR(191) NOT NULL,
      owner_id VARCHAR(191) NOT NULL, generation BIGINT NOT NULL,
      phase VARCHAR(32) NOT NULL, started_at_ms BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, execution_id)
    )${suffix}`);
  }

  async begin(fence: SessionExecutionFence): Promise<boolean> {
    const active = `workspace_id = ? AND session_id = ? AND id = ? AND state = 'running'
      AND attempt_id = ? AND owner_id = ? AND generation = ? AND lease_expires_at_ms > ?`;
    const args = [fence.workspaceId, fence.sessionId, fence.executionId, fence.attemptId,
      fence.ownerId, fence.generation, this.now().getTime()];
    const result = await this.sql.batch([
      this.sql.prepare(`UPDATE managed_session_executions SET revision = revision + 1 WHERE ${active}`).bind(...args),
      this.sql.prepare(`INSERT INTO managed_session_dispatch_guards (workspace_id, session_id, revision)
        VALUES (?, ?, 0) ON CONFLICT (workspace_id, session_id) DO NOTHING`).bind(fence.workspaceId, fence.sessionId),
      this.sql.prepare(`UPDATE managed_session_dispatch_guards SET revision = revision + 1
        WHERE workspace_id = ? AND session_id = ?`).bind(fence.workspaceId, fence.sessionId),
      this.sql.prepare(`INSERT INTO managed_session_execution_dispatches
        (workspace_id, session_id, execution_id, attempt_id, owner_id, generation, phase, started_at_ms)
        SELECT ?, ?, ?, ?, ?, ?, 'started', ? WHERE EXISTS
          (SELECT 1 FROM managed_session_executions WHERE ${active})
        AND NOT EXISTS (SELECT 1 FROM managed_session_execution_dispatches
          WHERE workspace_id = ? AND session_id = ? AND phase <> 'finished')
        ON CONFLICT (workspace_id, execution_id) DO NOTHING`).bind(
          fence.workspaceId, fence.sessionId, fence.executionId, fence.attemptId, fence.ownerId,
          fence.generation, this.now().getTime(), ...args, fence.workspaceId, fence.sessionId),
    ]);
    return result[3]?.meta.changes === 1;
  }

  /** Positive evidence that business operations drained, before publishing idle.
   * A crash with only 'started' or 'unknown' can never use terminal recovery. */
  async drained(fence: SessionExecutionFence): Promise<void> {
    await this.setPhase(fence, "drained");
  }

  /** Claim only the idempotent post-terminal work. Lock the canonical lease
   * and transfer evidence atomically; an old owner cannot finish this claim. */
  async recoverTerminal(fence: SessionExecutionFence, readOnlyPublication = false): Promise<boolean> {
    const active = `workspace_id = ? AND session_id = ? AND id = ? AND state = 'running'
      AND attempt_id = ? AND owner_id = ? AND generation = ? AND lease_expires_at_ms > ?`;
    const args = [fence.workspaceId, fence.sessionId, fence.executionId, fence.attemptId,
      fence.ownerId, fence.generation, this.now().getTime()];
    const results = await this.sql.batch([
      this.sql.prepare(`UPDATE managed_session_executions SET revision = revision + 1 WHERE ${active}`).bind(...args),
      this.sql.prepare(`UPDATE managed_session_execution_dispatches
        SET phase = ?, attempt_id = ?, owner_id = ?, generation = ?
        WHERE workspace_id = ? AND session_id = ? AND execution_id = ?
          AND (phase IN ('drained', 'finished') OR (phase = 'publishing' AND ? = 1)) AND EXISTS
          (SELECT 1 FROM managed_session_executions WHERE ${active})`).bind(
            readOnlyPublication ? "publishing" : "started", fence.attemptId, fence.ownerId, fence.generation, fence.workspaceId, fence.sessionId,
            fence.executionId, readOnlyPublication ? 1 : 0, ...args),
    ]);
    return results[1]?.meta.changes === 1;
  }

  /** Read-only publication may be resumed. Every Files write first leaves that
   * state; only a confirmed response restores it. A lost write response must
   * never be mistaken for a harmless interrupted read. */
  async publicationWrite(fence: SessionExecutionFence, confirmed: boolean): Promise<boolean> {
    const active = `workspace_id = ? AND session_id = ? AND id = ? AND state = 'running'
      AND attempt_id = ? AND owner_id = ? AND generation = ? AND lease_expires_at_ms > ?`;
    const args = [fence.workspaceId, fence.sessionId, fence.executionId, fence.attemptId,
      fence.ownerId, fence.generation, this.now().getTime()];
    const results = await this.sql.batch([
      this.sql.prepare(`UPDATE managed_session_executions SET revision = revision + 1 WHERE ${active}`).bind(...args),
      this.sql.prepare(`UPDATE managed_session_execution_dispatches SET phase = ?
        WHERE workspace_id = ? AND session_id = ? AND execution_id = ?
          AND attempt_id = ? AND owner_id = ? AND generation = ? AND phase = ?
          AND EXISTS (SELECT 1 FROM managed_session_executions WHERE ${active})`).bind(
            confirmed ? "publishing" : "started", fence.workspaceId, fence.sessionId, fence.executionId,
            fence.attemptId, fence.ownerId, fence.generation, confirmed ? "started" : "publishing", ...args),
    ]);
    return results[1]?.meta.changes === 1;
  }

  /** A late owner may report its own drained operations, never another
   * attempt's result. Uncertainty is sticky; ordinary input cannot clear it. */
  async finish(fence: SessionExecutionFence, unknown: boolean): Promise<void> {
    await this.setPhase(fence, unknown ? "unknown" : "finished");
  }

  private async setPhase(fence: SessionExecutionFence, phase: string): Promise<void> {
    await this.sql.prepare(`UPDATE managed_session_execution_dispatches SET phase = ?
      WHERE workspace_id = ? AND session_id = ? AND execution_id = ?
        AND attempt_id = ? AND owner_id = ? AND generation = ?
        AND phase IN ('started', 'drained', 'publishing')`).bind(phase, fence.workspaceId,
      fence.sessionId, fence.executionId, fence.attemptId, fence.ownerId, fence.generation).run();
  }
}
