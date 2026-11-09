// Fence-bound checks over one workspace's execution lease and Session record
// (design §0.0 rule 10): the native Cloudflare egress binding, the GitHub
// lookup, and the legacy (pre-#561) credentials during the deploy transition.

import {
  currentSessionExecutionLease,
  type SessionExecutionAttemptRef,
  type SessionExecutionLeases,
} from "@open-managed-agents/session-runtime/execution-lease";
import type { SandboxEgressScope } from "./sandbox-egress-credential";

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

/** Vault egress by fence (native binding, legacy pass): only while the
 * attempt is current and its Session usable. No attempt → no egress. */
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
