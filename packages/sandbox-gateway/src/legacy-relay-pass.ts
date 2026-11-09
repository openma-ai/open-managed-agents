// DEPLOY TRANSITION ONLY — verify, never issue. The pre-#561 HMAC relay pass
// (`<payload>.<hmac>`, credential-relay.v2) bound to an execution attempt.
// It is accepted only while that attempt is still the running one with a
// live lease, checked against the database on every request.
//
// REMOVE in the release after the one that introduced the sandbox token:
// a pass was issued only while its attempt ran, its TTL was 1 h, and every
// attempt started after the deploy gets a sandbox token instead, so once the
// last pre-deploy attempt has settled (bounded by the 1 h pass TTL) nothing
// can present one. Removing it = delete this file, its export, and the
// `legacyPass` wiring in apps/main and control-plane-node.

import type { SessionExecutionAttemptRef } from "@open-managed-agents/session-runtime/execution-lease";
import type { SandboxEgressDecision } from "./sandbox-egress-credential";
import { authorizeSandboxEgress, type SandboxGatewayStores } from "./sandbox-execution-credential";

const decode = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

export function legacyRelayPassVerifier(secret: string, now: () => number = Date.now) {
  const key = crypto.subtle.importKey("raw", new TextEncoder().encode(`credential-relay.v2:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return async (pass: string): Promise<SessionExecutionAttemptRef | null> => {
    try {
      const [payload, signature, extra] = pass.split(".");
      if (!payload || !signature || extra !== undefined) return null;
      if (!await crypto.subtle.verify("HMAC", await key, decode(signature), new TextEncoder().encode(payload))) return null;
      const claims = JSON.parse(new TextDecoder().decode(decode(payload))) as SessionExecutionAttemptRef & { expiresAt: number };
      const text = (value: unknown) => typeof value === "string" && value !== "";
      return text(claims.workspaceId) && text(claims.sessionId) && text(claims.executionId) && text(claims.attemptId) && text(claims.ownerId)
        && Number.isSafeInteger(claims.generation) && claims.generation >= 1 && Number.isFinite(claims.expiresAt) && claims.expiresAt > now()
        ? claims : null;
    } catch { return null; }
  };
}

/** The legacy pass, checked against the live lease (no attempt → rejected). */
export function legacyRelayPassCheck(secret: string, stores: SandboxGatewayStores, now: () => number = Date.now) {
  const verify = legacyRelayPassVerifier(secret, now);
  return async (pass: string): Promise<SandboxEgressDecision> => {
    const claims = await verify(pass);
    if (claims === null) return { type: "rejected" };
    try {
      const scope = await authorizeSandboxEgress(stores, claims, now);
      return scope === null ? { type: "rejected" } : { type: "accepted", scope };
    } catch (error) {
      return { type: "unavailable", error };
    }
  };
}
