// The sealed bearer (`sk-ant-req-v1.`) is the ADR 0005 self-hosted Work
// token and nothing else (design §0.0b B.4): checked against the current Work
// claim on every request. A pre-#561 execution sessions_token is not
// accepted; the sandbox token (#561) replaced it.

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

/** ADR 0005 self-hosted Environment Work token, checked against the current Work claim. */
export interface SandboxBearerAuthority {
  work: { codec: SandboxBearerCodec; isCurrentClaim(claim: SandboxBearerClaim): Promise<boolean> } | null;
}

export type SandboxBearerDecision =
  | { type: "resolved"; resolution: SandboxBearerResolution }
  | { type: "none" }
  | { type: "unavailable"; error: unknown };

/** The codec swallows errors (a bad token is just null), so a failed
 * database read inside `isCurrentClaim` is recorded and surfaced as unavailable. */
export async function authenticateSandboxBearer(
  authority: SandboxBearerAuthority,
  request: SandboxBearerRequest,
): Promise<SandboxBearerDecision> {
  const work = authority.work;
  if (work === null) return { type: "none" };
  let failure: { error: unknown } | null = null;
  try {
    const resolution = await work.codec.open(request, async (claim) => {
      try { return await work.isCurrentClaim(claim); } catch (error) { failure = { error }; throw error; }
    });
    if (failure !== null) return { type: "unavailable", error: (failure as { error: unknown }).error };
    return resolution === null ? { type: "none" } : { type: "resolved", resolution };
  } catch (error) {
    return { type: "unavailable", error };
  }
}
