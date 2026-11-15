// SandboxTokenStore over the Environment Work claim (ADR 0005): the
// self-hosted lane's sandbox tokens belong to the protocol Work claim, not to
// a Session execution attempt or a second fence. The hashes are a JSON array
// on managed_environment_work.sandbox_token_hashes (same {h, s} entries as the
// execution store). Every claim (first claim or reclaim) resets the column in
// the claim statement itself (SqlEnvironmentWorkStore.claimAvailable), so a
// token never outlives the claim it was issued under.
//
// A token verifies only while its claim holds: the Work is starting or
// active and claim_at + heartbeat_ttl_seconds (the lease the protocol's
// heartbeat 412 enforces) has not passed. Losing the claim (reclaim, force
// stop, an expired lease, the Work ending) is therefore an immediate 401.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SandboxTokenAttempt, SandboxTokenStore, SessionExecutionAttemptRef } from "@open-managed-agents/sandbox-gateway";
import { entries, replacementTokenHashes, sessionOf, type SessionRow } from "./sandbox-token-store-sql";

const REPLACE_RETRIES = 8;
const ATTEMPT_PREFIX = "environment-work-claim:";
const HELD_CLAIM = `workspace_id = ? AND environment_id = ? AND id = ? AND session_id = ? AND claim_generation = ?
              AND claim_at IS NOT NULL AND claim_at + heartbeat_ttl_seconds * 1000 > ?
              AND state IN ('queued', 'starting', 'active')`;

/** The claim the store keys a token to: (workspace, environment, Session, Work, claim_generation). */
export interface EnvironmentWorkTokenClaim {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  /** claim_generation of the claim (only a claim bumps it). */
  generation: number;
}

/** The attempt ref issueSandboxToken takes, naming one Work claim. */
export function environmentWorkSandboxTokenRef(claim: EnvironmentWorkTokenClaim): SessionExecutionAttemptRef {
  return {
    workspaceId: claim.workspaceId,
    sessionId: claim.sessionId,
    executionId: claim.workId,
    attemptId: `${ATTEMPT_PREFIX}${claim.generation}`,
    ownerId: claim.environmentId,
    generation: claim.generation,
  };
}

/** Clear a token issued during a Work bootstrap that was rejected before the
 * native worker launched. The claim identity and holder hash fence this
 * maintenance write so a later claim cannot be modified by an old bootstrap.
 */
export async function clearEnvironmentWorkToken(
  sql: SqlClient,
  claim: EnvironmentWorkTokenClaim,
  holderHash: string,
): Promise<void> {
  await sql.prepare(
    `UPDATE managed_environment_work SET sandbox_token_hashes = NULL
       WHERE workspace_id = ? AND environment_id = ? AND id = ? AND session_id = ?
         AND claim_generation = ? AND state IN ('queued', 'starting', 'active')
         AND sandbox_token_hashes LIKE ?`,
  ).bind(
    claim.workspaceId,
    claim.environmentId,
    claim.workId,
    claim.sessionId,
    claim.generation,
    `%"${holderHash}"%`,
  ).run();
}

function claimOf(fence: SessionExecutionAttemptRef): EnvironmentWorkTokenClaim | null {
  if (
    !Number.isSafeInteger(fence.generation) || fence.generation < 1
    || fence.attemptId !== `${ATTEMPT_PREFIX}${fence.generation}` || fence.ownerId === ""
  ) return null;
  return {
    workspaceId: fence.workspaceId, environmentId: fence.ownerId, sessionId: fence.sessionId,
    workId: fence.executionId, generation: fence.generation,
  };
}

interface FoundRow extends SessionRow {
  work_id: string | null; work_environment_id: string | null; claim_generation: number | string | null;
  claim_at: number | string | null; heartbeat_ttl_seconds: number | string | null; sandbox_token_hashes: string | null;
}

export function createSqlEnvironmentWorkSandboxTokenStore(sql: SqlClient): SandboxTokenStore & {
  isCurrentDelivery(input: { claim: EnvironmentWorkTokenClaim; tokenSha256: string; scope: "all" | "egress"; nowMs: number }): Promise<boolean>;
} {
  return {
    /** Bootstrap may precede ACK. Read-only: never revive a replaced hash. */
    async isCurrentDelivery({ claim, tokenSha256, scope, nowMs }) {
      const row = await sql.prepare(
        `SELECT sandbox_token_hashes FROM managed_environment_work WHERE ${HELD_CLAIM}`
      ).bind(claim.workspaceId, claim.environmentId, claim.workId, claim.sessionId, claim.generation, nowMs).first<{ sandbox_token_hashes: string | null }>();
      return row !== null && entries(row.sandbox_token_hashes).some(entry => entry.hash === tokenSha256 && entry.scope === scope);
    },
    // One statement: Session row + its held Work claim holding the hash.
    async find({ sessionId, tokenSha256 }) {
      const row = await sql.prepare(
        `SELECT s.id, s.workspace_id, s.document, s.archived_at, s.environment_id, s.agent_id, s.agent_version,
                w.id AS work_id, w.environment_id AS work_environment_id, w.claim_generation,
                w.claim_at, w.heartbeat_ttl_seconds, w.sandbox_token_hashes
           FROM managed_sessions s
           LEFT JOIN managed_environment_work w
             ON w.workspace_id = s.workspace_id AND w.session_id = s.id
            AND w.state IN ('starting', 'active') AND w.claim_at IS NOT NULL
            AND w.sandbox_token_hashes LIKE ?
          WHERE s.id = ?`,
      ).bind(`%"${tokenSha256.slice(0, 32)}%`, sessionId).first<FoundRow>();
      if (row === null) return null;
      const session = sessionOf(row);
      const entry = entries(row.sandbox_token_hashes).find((candidate) => candidate.hash === tokenSha256);
      const attempt: SandboxTokenAttempt | null = row.work_id !== null && row.work_environment_id !== null
        && row.claim_generation !== null && row.claim_at !== null && row.heartbeat_ttl_seconds !== null
        && entry !== undefined
        ? {
            executionId: row.work_id,
            attemptId: `${ATTEMPT_PREFIX}${Number(row.claim_generation)}`,
            ownerId: row.work_environment_id,
            generation: Number(row.claim_generation),
            claimedAtMs: Number(row.claim_at),
            leaseExpiresAtMs: Number(row.claim_at) + Number(row.heartbeat_ttl_seconds) * 1_000,
            tokenScope: entry.scope,
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
    // Compare-and-set on the column while the claim is current. A queued
    // (claimed, not yet acknowledged) Work may be issued its token at poll;
    // it verifies only once the Work is starting.
    async replaceTokenHash({ fence, tokenSha256, scope, nowMs }) {
      const claim = claimOf(fence);
      if (claim === null) return "stale";
      const held = HELD_CLAIM;
      const heldParameters = [claim.workspaceId, claim.environmentId, claim.workId, claim.sessionId, claim.generation, nowMs];
      for (let attempt = 0; attempt < REPLACE_RETRIES; attempt++) {
        const current = await sql.prepare(`SELECT sandbox_token_hashes FROM managed_environment_work WHERE ${held}`)
          .bind(...heldParameters).first<{ sandbox_token_hashes: string | null }>();
        if (current === null) return "stale";
        const set = entries(current.sandbox_token_hashes);
        if (set.some((entry) => entry.scope !== scope)) return "scope_mismatch";
        if (set.some((entry) => entry.hash === tokenSha256)) return "replaced";
        const result = await sql.prepare(
          `UPDATE managed_environment_work SET sandbox_token_hashes = ?
            WHERE ${held} AND COALESCE(sandbox_token_hashes, '') = ?`,
        ).bind(replacementTokenHashes(tokenSha256, scope), ...heldParameters, current.sandbox_token_hashes ?? "").run();
        if (result.meta.changes === 1) return "replaced";
      }
      throw new Error("Sandbox token replacement kept conflicting");
    },
  };
}
