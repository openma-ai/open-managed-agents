// The one Session execution fence check (design §0.0 rule 10). Storage
// write-back, output / ResumeRef publication, the Vault egress gateway, the
// model gateway and the MCP proxy all ask this, on Cloudflare and Node alike.
// Platforms inject only the lease reader (SQL: @open-managed-agents/session-runtime-sql/execution-lease;
// a coordinator can be wrapped with sessionExecutionLeasesFrom).
//
// The authority is the current attempt row in managed_session_executions. The
// fence's own expiresAt is NOT trusted: a fence snapshot, pass or token carries
// the lease expiry at issue time, while heartbeats renew only the row.

import type { SessionExecution } from "@open-managed-agents/session-runtime-contract";

export interface SessionExecutionLease {
  executionId: string;
  sessionId: string;
  state: string;
  attemptId: string | null;
  ownerId: string | null;
  generation: number | null;
  claimedAtMs: number | null;
  leaseExpiresAtMs: number | null;
}

export interface SessionExecutionLeases {
  find(input: { workspaceId: string; executionId: string }): Promise<SessionExecutionLease | null>;
}

/** The attempt a fence, relay pass or sandbox binding names. A
 * SessionExecutionFence satisfies it; its expiresAt is ignored. */
export interface SessionExecutionAttemptRef {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
}

/** Credential-side form (a sessions_token carries the execution, its
 * generation and claim time, not the attempt id). */
export interface SessionExecutionClaim {
  workspaceId: string;
  sessionId: string;
  executionId: string;
  generation: number;
  claimedAt: string;
}

/** Lease reader over a coordinator's find (Node's SqlSessionExecutionCoordinator). */
export function sessionExecutionLeasesFrom(
  find: (input: { workspaceId: string; executionId: string }) => Promise<SessionExecution | null>,
): SessionExecutionLeases {
  return {
    async find(input) {
      const execution = await find(input);
      if (execution === null) return null;
      return {
        executionId: execution.id,
        sessionId: execution.sessionId,
        state: execution.state,
        attemptId: execution.attempt?.id ?? null,
        ownerId: execution.attempt?.ownerId ?? null,
        generation: execution.attempt?.generation ?? null,
        claimedAtMs: execution.attempt ? Date.parse(execution.attempt.claimedAt) : null,
        leaseExpiresAtMs: execution.attempt ? Date.parse(execution.attempt.leaseExpiresAt) : null,
      };
    },
  };
}

function live(lease: SessionExecutionLease | null, sessionId: string, generation: number, nowMs: number): lease is SessionExecutionLease {
  return lease !== null
    && lease.state === "running"
    && lease.sessionId === sessionId
    && lease.generation === generation
    && lease.leaseExpiresAtMs !== null
    && lease.leaseExpiresAtMs > nowMs;
}

function wellFormed(ref: { workspaceId: string; sessionId: string; executionId: string; generation: number }): boolean {
  return ref.workspaceId !== "" && ref.sessionId !== "" && ref.executionId !== ""
    && Number.isSafeInteger(ref.generation) && ref.generation >= 1;
}

/** The live lease while `fence` is still the current attempt of a running execution; else null. */
export async function currentSessionExecutionLease(
  leases: SessionExecutionLeases,
  fence: SessionExecutionAttemptRef,
  now: () => number = Date.now,
): Promise<SessionExecutionLease | null> {
  if (!wellFormed(fence) || fence.attemptId === "" || fence.ownerId === "") return null;
  const lease = await leases.find({ workspaceId: fence.workspaceId, executionId: fence.executionId });
  return live(lease, fence.sessionId, fence.generation, now())
    && lease.attemptId === fence.attemptId
    && lease.ownerId === fence.ownerId ? lease : null;
}

/** True while `fence` is still the current attempt of a running execution. */
export async function isSessionExecutionFenceActive(
  leases: SessionExecutionLeases,
  fence: SessionExecutionAttemptRef,
  now: () => number = Date.now,
): Promise<boolean> {
  return await currentSessionExecutionLease(leases, fence, now) !== null;
}

/** Same check for a credential claim (sessions_token). */
export async function isSessionExecutionClaimActive(
  leases: SessionExecutionLeases,
  claim: SessionExecutionClaim,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!wellFormed(claim)) return false;
  const claimedAtMs = Date.parse(claim.claimedAt);
  if (!Number.isFinite(claimedAtMs)) return false;
  const lease = await leases.find({ workspaceId: claim.workspaceId, executionId: claim.executionId });
  return live(lease, claim.sessionId, claim.generation, now()) && lease.claimedAtMs === claimedAtMs;
}
