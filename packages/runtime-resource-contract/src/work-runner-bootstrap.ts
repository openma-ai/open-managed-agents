import type { RuntimeResourceScope } from "./scope";

/** Management-only delivery of an already-reserved Work claim. No standing
 * Environment key and no ACP stdio. The runner owns existing ACK/heartbeat. */
export interface EnvironmentWorkRuntimeDelivery extends RuntimeResourceScope {
  apiBaseUrl: string;
  /** Exact per-claim Work secret returned by poll; sensitive, never log. */
  workSecret: string;
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
