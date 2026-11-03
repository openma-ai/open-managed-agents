// Moved to @openma/core (#434). Kept so existing imports keep working.
export type * from "@openma/core/storage/environment-work";

import type {
  CurrentEnvironmentWorkClaim,
  EnvironmentWorkStore,
} from "@openma/core/storage/environment-work";

/**
 * Resolve a bearer against the current claimed Work, not merely its
 * cryptographic expiry. A replacement claim rotates the stored token and
 * immediately fences the previous executor from canonical Session writes.
 */
export async function isCurrentEnvironmentWorkClaim(
  dependencies: { store: EnvironmentWorkStore; now(): Date },
  claim: CurrentEnvironmentWorkClaim,
): Promise<boolean> {
  const current = await dependencies.store.find({
    workspaceId: claim.workspaceId,
    environmentId: claim.environmentId,
    workId: claim.workId,
  });
  if (
    current === null
    || current.work.data.type !== "session"
    || current.work.data.id !== claim.sessionId
    || current.claim === null
    || current.claim.generation !== claim.generation
    || current.secret.sessionsToken !== claim.token
  ) return false;

  // Poll reserves a queued item. Its scoped bearer must be able to ACK
  // before the item becomes starting, without granting Session access yet.
  if (current.work.state === "queued") {
    return claim.method === "POST"
      && claim.path === `/v1/environments/${encodeURIComponent(claim.environmentId)}/work/${encodeURIComponent(claim.workId)}/ack`
      && Date.parse(current.claim.claimedAt) + current.heartbeatTtlSeconds * 1_000 > dependencies.now().getTime();
  }
  const workControlRequest = claim.path.startsWith(
    `/v1/environments/${encodeURIComponent(claim.environmentId)}/work/${encodeURIComponent(claim.workId)}/`,
  );
  if (
    current.work.state !== "starting"
    && current.work.state !== "active"
    && !(current.work.state === "stopping" && workControlRequest)
  ) return false;

  // Heartbeat and stop are the Work protocol's authority checks. Let the
  // current claim reach them even after its TTL so the application can return
  // the canonical 412 (or complete cleanup). An expired executor must never
  // use the same grace path to append Session state.
  if (workControlRequest) return true;
  return Date.parse(current.claim.claimedAt)
    + current.heartbeatTtlSeconds * 1_000
    > dependencies.now().getTime();
}
