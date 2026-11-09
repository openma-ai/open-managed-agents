// Sealed bearers (`sk-ant-req-v1.`): the ADR 0005 self-hosted Work token
// (current), and — DEPLOY TRANSITION ONLY — the pre-#561 execution
// sessions_token. Both are checked against the database on every request.
//
// The `execution` branch is verify-only and REMOVABLE in the release after
// the one that introduced the sandbox token: a sealed execution token was
// issued per execution attempt and is accepted only while that attempt is
// the running one, and attempts started after the deploy get a sandbox
// token, so once pre-deploy attempts have settled nothing presents one.
// Removing it = drop `execution` here and its wiring (apps/main
// cfAcpExecutionAuthority, control-plane-node managedAcpCapabilities).

import { isSessionExecutionClaimActive } from "@open-managed-agents/session-runtime/execution-lease";
import type { SandboxGatewayStores } from "./sandbox-execution-credential";

export interface SandboxBearerRequest { token: string; method: string; path: string }
export interface SandboxBearerResolution {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  claimedAt: string;
  generation: number;
}
export interface SandboxBearerClaim extends SandboxBearerResolution, SandboxBearerRequest {}

/** Opens a sealed bearer (route scope + crypto expiry); null for anything else. */
export interface SandboxBearerCodec {
  open(request: SandboxBearerRequest, isCurrent: (claim: SandboxBearerClaim) => Promise<boolean>): Promise<SandboxBearerResolution | null>;
}

export interface SandboxBearerAuthority {
  /** Legacy execution sessions_token (proxy routes only); null = none. */
  execution: { codec: SandboxBearerCodec; stores: SandboxGatewayStores } | null;
  /** ADR 0005 self-hosted Environment Work token, checked against the current Work claim. */
  work: { codec: SandboxBearerCodec; isCurrentClaim(claim: SandboxBearerClaim): Promise<boolean> } | null;
  now?: () => number;
}

export type SandboxBearerDecision =
  | { type: "resolved"; resolution: SandboxBearerResolution }
  | { type: "none" }
  | { type: "unavailable"; error: unknown };

const EXECUTION_TOKEN_PATH = /^\/v1\/oma\/(?:mcp-proxy|inference-proxy)\//u;

/** The codecs swallow errors (a bad token is just null), so a failed
 * database read inside `isCurrent` is recorded and surfaced as unavailable. */
async function openChecked(codec: SandboxBearerCodec, request: SandboxBearerRequest, isCurrent: (claim: SandboxBearerClaim) => Promise<boolean>): Promise<SandboxBearerDecision> {
  let failure: { error: unknown } | null = null;
  try {
    const resolution = await codec.open(request, async (claim) => {
      try { return await isCurrent(claim); } catch (error) { failure = { error }; throw error; }
    });
    if (failure !== null) return { type: "unavailable", error: (failure as { error: unknown }).error };
    return resolution === null ? { type: "none" } : { type: "resolved", resolution };
  } catch (error) {
    return { type: "unavailable", error };
  }
}

/** The legacy execution token first (proxy routes only), then the Work token. */
export async function authenticateSandboxBearer(
  authority: SandboxBearerAuthority,
  request: SandboxBearerRequest,
): Promise<SandboxBearerDecision> {
  const now = authority.now ?? Date.now;
  const execution = authority.execution;
  if (execution !== null && EXECUTION_TOKEN_PATH.test(request.path)) {
    const decision = await openChecked(execution.codec, request, async (claim) => {
      const store = await execution.stores(claim.workspaceId);
      const active = await isSessionExecutionClaimActive(store.leases, {
        workspaceId: claim.workspaceId, sessionId: claim.sessionId, executionId: claim.workId,
        generation: claim.generation, claimedAt: claim.claimedAt,
      }, now);
      if (!active) return false;
      const session = await store.findSession({ workspaceId: claim.workspaceId, sessionId: claim.sessionId });
      return session !== null && session.archivedAt === null && session.environmentId === claim.environmentId;
    });
    if (decision.type !== "none") return decision;
  }
  const work = authority.work;
  return work === null ? { type: "none" } : openChecked(work.codec, request, (claim) => work.isCurrentClaim(claim));
}
