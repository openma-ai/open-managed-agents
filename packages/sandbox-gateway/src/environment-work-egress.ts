// Credential egress for a self-hosted Environment Work sandbox (ADR 0005, the
// exception in design §0.0 rule 10): that lane has no Session execution
// attempt, so its authority is the protocol Work claim itself — the same
// managed_environment_work row that poll, heartbeat (412) and stop mutate.
// Cloudflare and Node share this check; the platform injects the claim
// reader and the Session lookup.

/** The Work claim a sandbox binding carries: `generation` is the Work's
 * claim_generation, `token` the claim's Work token. */
export interface EnvironmentWorkEgressClaim {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  generation: number;
  token: string;
}

/** Satisfied by EnvironmentWorkClaimPort: the Work row decides. */
export interface EnvironmentWorkClaims {
  isCurrent(claim: EnvironmentWorkEgressClaim): Promise<boolean>;
}

export type EnvironmentWorkSessionLookup = (input: { workspaceId: string; sessionId: string }) =>
  Promise<{ archivedAt: string | null; vaultIds: readonly string[] } | null>;

/** Vault egress: only while the Work claim is current and its Session usable. */
export async function authorizeEnvironmentWorkEgress(
  claims: EnvironmentWorkClaims,
  findSession: EnvironmentWorkSessionLookup,
  claim: EnvironmentWorkEgressClaim,
): Promise<{ workspaceId: string; sessionId: string; vaultIds: readonly string[] } | null> {
  if (!await claims.isCurrent(claim)) return null;
  const session = await findSession({ workspaceId: claim.workspaceId, sessionId: claim.sessionId });
  if (session === null || session.archivedAt !== null) return null;
  return { workspaceId: claim.workspaceId, sessionId: claim.sessionId, vaultIds: session.vaultIds };
}
