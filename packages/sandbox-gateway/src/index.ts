// Sandbox-originated request authority (design §0.0 rule 10, §0.7). The
// Vault egress gateway, the model gateway and the MCP proxy authenticate
// here, and the credentials handed to a sandbox (relay pass, execution
// sessions_token) are bound here to the Session execution attempt. One
// implementation for Cloudflare and Node: platforms inject only their
// per-workspace stores (@open-managed-agents/sandbox-gateway-sql) and the
// sealing codecs.

import {
  currentSessionExecutionLease,
  isSessionExecutionClaimActive,
  type SessionExecutionAttemptRef,
  type SessionExecutionLease,
  type SessionExecutionLeases,
} from "@open-managed-agents/session-runtime/execution-lease";

export type { SessionExecutionAttemptRef, SessionExecutionLease, SessionExecutionLeases };

export interface SandboxGatewaySession {
  archivedAt: string | null;
  environmentId: string;
  vaultIds: readonly string[];
  agent: { id: string; version: number };
}

/** One workspace's reads: the execution lease and the Session record. */
export interface SandboxGatewayStore {
  leases: SessionExecutionLeases;
  findSession(input: { workspaceId: string; sessionId: string }): Promise<SandboxGatewaySession | null>;
}
export type SandboxGatewayStores = (workspaceId: string) => SandboxGatewayStore | Promise<SandboxGatewayStore>;

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
  /** Execution sessions_token, accepted only on the model gateway and MCP
   * proxy; null where the platform issues none. */
  execution: { codec: SandboxBearerCodec; stores: SandboxGatewayStores } | null;
  /** ADR 0005 self-hosted Environment Work token, checked against the current Work claim. */
  work: { codec: SandboxBearerCodec; isCurrentClaim(claim: SandboxBearerClaim): Promise<boolean> } | null;
  now?: () => number;
}

const EXECUTION_TOKEN_PATH = /^\/v1\/oma\/(?:mcp-proxy|inference-proxy)\//u;

/** The execution token first (proxy routes only), then the Work token. */
export async function authenticateSandboxBearer(
  authority: SandboxBearerAuthority,
  request: SandboxBearerRequest,
): Promise<SandboxBearerResolution | null> {
  const now = authority.now ?? Date.now;
  const execution = authority.execution;
  if (execution !== null && EXECUTION_TOKEN_PATH.test(request.path)) {
    const scoped = await execution.codec.open(request, async (claim) => {
      const store = await execution.stores(claim.workspaceId);
      const active = await isSessionExecutionClaimActive(store.leases, {
        workspaceId: claim.workspaceId, sessionId: claim.sessionId, executionId: claim.workId,
        generation: claim.generation, claimedAt: claim.claimedAt,
      }, now);
      if (!active) return false;
      const session = await store.findSession({ workspaceId: claim.workspaceId, sessionId: claim.sessionId });
      return session !== null && session.archivedAt === null && session.environmentId === claim.environmentId;
    });
    if (scoped !== null) return scoped;
  }
  const work = authority.work;
  return work === null ? null : work.codec.open(request, (claim) => work.isCurrentClaim(claim));
}

/** Before minting an execution sessions_token: the fence must name the
 * current attempt (the lease row is the authority, not the fence's own
 * expiry) and the Session must be usable by this environment and agent.
 * Returns the live lease the token binds to. */
export async function authorizeExecutionCredential(
  stores: SandboxGatewayStores,
  fence: SessionExecutionAttemptRef | undefined,
  expected: { workspaceId: string; sessionId: string; environmentId: string; agent: { id: string; version: number } },
  now: () => number = Date.now,
): Promise<SessionExecutionLease & { claimedAtMs: number; generation: number }> {
  if (!fence || fence.workspaceId !== expected.workspaceId || fence.sessionId !== expected.sessionId) {
    throw new Error("Sandbox execution credential requires a current Session Execution fence");
  }
  const store = await stores(expected.workspaceId);
  const session = await store.findSession({ workspaceId: expected.workspaceId, sessionId: expected.sessionId });
  if (!session) throw new Error(`Session ${expected.sessionId} was not found`);
  if (session.archivedAt !== null) throw new Error(`Session ${expected.sessionId} is archived and cannot receive new events`);
  if (session.environmentId !== expected.environmentId) {
    throw new Error("Sandbox execution credential requires the Session environment (child ACP capabilities are not supported)");
  }
  if (session.agent.id !== expected.agent.id || session.agent.version !== expected.agent.version) {
    throw new Error("Sandbox execution credential requires the pinned Session agent (child ACP capabilities are not supported)");
  }
  const lease = await currentSessionExecutionLease(store.leases, fence, now);
  if (lease === null || lease.claimedAtMs === null || lease.generation === null) {
    throw new Error("Sandbox execution credential Session Execution fence is stale");
  }
  return lease as SessionExecutionLease & { claimedAtMs: number; generation: number };
}

export interface SandboxEgressScope { workspaceId: string; sessionId: string; vaultIds: readonly string[] }

/** Vault egress (relay pass or native binding): only while the attempt is
 * current and its Session usable. No attempt → no egress. */
export async function authorizeSandboxEgress(
  stores: SandboxGatewayStores,
  fence: SessionExecutionAttemptRef | null | undefined,
  now: () => number = Date.now,
): Promise<SandboxEgressScope | null> {
  if (!fence) return null;
  const store = await stores(fence.workspaceId);
  if (await currentSessionExecutionLease(store.leases, fence, now) === null) return null;
  const session = await store.findSession({ workspaceId: fence.workspaceId, sessionId: fence.sessionId });
  if (session === null || session.archivedAt !== null) return null;
  return { workspaceId: fence.workspaceId, sessionId: fence.sessionId, vaultIds: session.vaultIds };
}

/** Never verifies: what a sandbox gets when no attempt is running, so the
 * relay denies it (401) without failing the sandbox open. */
export const UNFENCED_RELAY_PASS = "unfenced";

/** A relay pass bound to the attempt; `issue` is the platform's signer. */
export async function issueSandboxRelayPass(
  issue: (input: SessionExecutionAttemptRef & { ttlMs: number }) => Promise<string>,
  fence: SessionExecutionAttemptRef | null | undefined,
  ttlMs: number,
): Promise<string> {
  if (!fence) return UNFENCED_RELAY_PASS;
  return issue({
    workspaceId: fence.workspaceId, sessionId: fence.sessionId, executionId: fence.executionId,
    attemptId: fence.attemptId, ownerId: fence.ownerId, generation: fence.generation, ttlMs,
  });
}
