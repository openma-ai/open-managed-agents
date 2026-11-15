import type { RuntimeCheckpointRef } from "./checkpoint";
import type { RuntimePublicationCandidate, RuntimeResourcePublication } from "./fence";
import type { RuntimeResourceScope } from "./scope";

/**
 * The protocol Environment Work claim a self-hosted Runtime Host executes
 * under (ADR 0005). Poll/ack/heartbeat/stop own it; this is the host's
 * reference to it, not a lease of its own.
 */
export interface EnvironmentWorkClaim extends RuntimeResourceScope {
  /** `claim_generation` of the claim, carried in the claimed Work secret. */
  generation: number;
  /** The claim's Work token (sessions_token). Must never be logged. */
  token: string;
}

export type OpenEnvironmentWorkClaimResult =
  | {
      type: "current";
      /** Lease expiry of the claim when it was read; informational only. */
      expiresAt: string;
      /** Restore pointer published under an earlier claim of the same Work. */
      publication: RuntimeResourcePublication | null;
    }
  | { type: "lost" };

export type PublishRuntimeResourcesResult =
  | { type: "published"; revision: number }
  | { type: "lost" };

/**
 * Claim-conditioned reads and writes on the Work record. `publish` must
 * validate the claim and advance the restore pointer in one conditional
 * write: checking ownership and publishing in two calls would reopen the
 * stale-owner window.
 */
export interface EnvironmentWorkClaimPort {
  /** Before acquiring resources: the claim is current and not stopping. */
  open(claim: EnvironmentWorkClaim): Promise<OpenEnvironmentWorkClaimResult>;
  /** Read-only check before mutations that cannot join the publication write. */
  isCurrent(claim: EnvironmentWorkClaim): Promise<boolean>;
  publish(input: {
    claim: EnvironmentWorkClaim;
    /** Host-only final publication may drain a stopped, unreclaimed generation.
     * This never authorizes execution or sandbox credentials. */
    final?: boolean;
    workspaceCandidate: RuntimePublicationCandidate;
    outputCandidate: RuntimePublicationCandidate | null;
    runtimeCheckpoint?: RuntimeCheckpointRef | null;
  }): Promise<PublishRuntimeResourcesResult>;
}
