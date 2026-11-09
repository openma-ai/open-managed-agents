import type {
  EnvironmentWorkClaim,
  EnvironmentWorkClaimPort,
  RuntimeResourceFence,
} from "@open-managed-agents/runtime-resource-contract";

/** Open a Work claim the way the Runtime Host does and return the Port-call
 * fence it derives, plus the published restore pointer. */
export async function openClaim(
  claims: EnvironmentWorkClaimPort,
  claim: EnvironmentWorkClaim,
  ownerId: string,
) {
  const opened = await claims.open(claim);
  if (opened.type !== "current") throw new Error("expected a current Work claim");
  const { generation, token, ...scope } = claim;
  const fence: RuntimeResourceFence = { ...scope, ownerId, generation, token, expiresAt: opened.expiresAt };
  return { fence, publication: opened.publication };
}

/** The claim reference `ManagedRuntimeHost.run` takes. */
export const runClaim = ({ generation, token }: EnvironmentWorkClaim) => ({ generation, token });
