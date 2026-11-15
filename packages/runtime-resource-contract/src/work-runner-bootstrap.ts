import type { RuntimeResourceScope } from "./scope";

/** Management-only delivery of an already-reserved Work claim. No standing
 * Environment key and no ACP stdio. The runner owns existing ACK/heartbeat. */
export interface EnvironmentWorkRuntimeDelivery extends RuntimeResourceScope {
  apiBaseUrl: string;
  /** Exact base64url(JSON{sessions_token,api_base_url}) returned by poll.
   * Not a raw HTTP bearer; do not re-encode, rotate, or log it here. */
  workSecret: string;
}

/** Deployment adapter over the EXISTING installed-harness inventory or common
 * release manifest. The caller supplies its authority-loaded pinned Session,
 * not Work metadata. No new registry or Agent id/version-to-harness fallback.
 * null/rejection blocks bootstrap; this callback does not sign tokens or ACK.
 * Resolve before the existing holder issues its placement-scoped token.
 */
export interface EnvironmentWorkInstalledHarnessResolver<TPinnedSession> {
  resolve(input: {
    scope: RuntimeResourceScope;
    pinnedSession: TPinnedSession;
    signal: AbortSignal;
  }): Promise<{ id: string; version: string } | null>;
}

/** Trusted placement is resolved from the pinned Session, never Work metadata.
 * This discriminant fixes scope BEFORE the sole existing holder signs once. */
export type EnvironmentWorkHarnessBootstrap =
  | { harnessPlacement:"in_sandbox"; sandboxTokenScope:"all"; harness:{id:string;version:string} }
  | { harnessPlacement:"outside_sandbox"; sandboxTokenScope:"egress"; harness:{id:string;version:string} };

export interface EnvironmentWorkRunnerBootstrap extends EnvironmentWorkRuntimeDelivery {
  selection: EnvironmentWorkHarnessBootstrap;
  /** The existing attempt holder's token, shared with egress on the same
   * physical incarnation. Bootstrap must not mint or upgrade this token. */
  sandboxToken: string;
}
