// Vault egress authentication (`/v1/oma/egress/{resolve,forward}`): the
// forwarder sends `Authorization: Basic base64(<sessionId>:<token>)` — the
// same pair a SOCKS5 user/password carries (#390 E2B BYOP). Nothing else is
// accepted (design §0.0b B.4: no pre-#561 credential). 401 only for a
// definite rejection; a store error is `unavailable` (503), and the
// forwarder stays up on it.

import { parseSandboxBasicCredential } from "./sandbox-token";
import { authenticateSandboxToken, authenticateSandboxTokenSha256, type SandboxTokenDecision } from "./sandbox-token-authority";
import type { SandboxTokenStore } from "./sandbox-token-store";

export interface SandboxEgressScope { workspaceId: string; sessionId: string; vaultIds: readonly string[] }

export type SandboxEgressDecision =
  | { type: "accepted"; scope: SandboxEgressScope }
  | { type: "rejected" }
  | { type: "unavailable"; error: unknown };

export async function authenticateSandboxEgress(
  store: SandboxTokenStore,
  authorization: string | null,
  options: { now?: () => number } = {},
): Promise<SandboxEgressDecision> {
  const basic = parseSandboxBasicCredential(authorization ?? "");
  if (basic === null) return { type: "rejected" };
  // The egress relay takes an `all` or an `egress` token.
  return egressDecision(await authenticateSandboxToken(store, { ...basic, channel: "egress" }, options.now));
}

/** The same egress decision for a Cloudflare outbound binding, which holds
 * the token's digest (its params are stored), not the token. */
export async function authenticateSandboxEgressSha256(
  store: SandboxTokenStore,
  input: { workspaceId: string; sessionId: string; tokenSha256: string | undefined },
  now?: () => number,
): Promise<SandboxEgressDecision> {
  if (input.tokenSha256 === undefined) return { type: "rejected" };
  const decision = egressDecision(await authenticateSandboxTokenSha256(store, { sessionId: input.sessionId, tokenSha256: input.tokenSha256, channel: "egress" }, now));
  return decision.type === "accepted" && decision.scope.workspaceId !== input.workspaceId ? { type: "rejected" } : decision;
}

function egressDecision(decision: SandboxTokenDecision): SandboxEgressDecision {
  if (decision.type !== "accepted") return decision;
  const { session } = decision;
  return { type: "accepted", scope: { workspaceId: session.workspaceId, sessionId: session.sessionId, vaultIds: session.vaultIds } };
}
