// Credential egress for a self-hosted Environment Work sandbox (ADR 0005, the
// exception in design §0.0 rule 10): that lane has no Session execution
// attempt, so its authority is the Work's publication fence. Cloudflare and
// Node share this check; the platform injects the fence reader and the
// Session lookup.

/** The fence a sandbox binding carries. */
export interface EnvironmentWorkFenceClaim {
  environmentId: string;
  workId: string;
  ownerId: string;
  generation: number;
  token: string;
}

export interface EnvironmentWorkFenceRef extends EnvironmentWorkFenceClaim {
  workspaceId: string;
  sessionId: string;
}

/** Satisfied by RuntimeResourceFencePort. The stored row decides; `expiresAt` is not read. */
export interface EnvironmentWorkFences {
  isCurrent(fence: EnvironmentWorkFenceRef & { expiresAt: string }): Promise<boolean>;
}

export type EnvironmentWorkSessionLookup = (input: { workspaceId: string; sessionId: string }) =>
  Promise<{ archivedAt: string | null; vaultIds: readonly string[] } | null>;

const UNTRUSTED_EXPIRY = new Date(0).toISOString();

export function isEnvironmentWorkFenceCurrent(fences: EnvironmentWorkFences, fence: EnvironmentWorkFenceRef): Promise<boolean> {
  return fences.isCurrent({ ...fence, expiresAt: UNTRUSTED_EXPIRY });
}

/** Vault egress: only while the fence is current and its Session usable. */
export async function authorizeEnvironmentWorkEgress(
  fences: EnvironmentWorkFences,
  findSession: EnvironmentWorkSessionLookup,
  fence: EnvironmentWorkFenceRef,
): Promise<{ workspaceId: string; sessionId: string; vaultIds: readonly string[] } | null> {
  if (!await isEnvironmentWorkFenceCurrent(fences, fence)) return null;
  const session = await findSession({ workspaceId: fence.workspaceId, sessionId: fence.sessionId });
  if (session === null || session.archivedAt !== null) return null;
  return { workspaceId: fence.workspaceId, sessionId: fence.sessionId, vaultIds: session.vaultIds };
}
