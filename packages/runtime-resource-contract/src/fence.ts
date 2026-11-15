import type { RuntimeResourceScope } from "./scope";
import type { RuntimeCheckpointRef } from "./checkpoint";

/**
 * The execution authority a Sandbox v2 Port call runs under, as one value.
 * It has no store of its own: it projects either a Session execution attempt
 * (cloud lane, `managed_session_executions`) or the protocol Environment Work
 * claim (self-hosted lane, `managed_environment_work`). See ADR 0005.
 */
export interface RuntimeResourceFence extends RuntimeResourceScope {
  ownerId: string;
  /** Attempt generation, or the Work's `claim_generation`. */
  generation: number;
  /** Opaque proof of ownership (attempt id, or the claim's Work token). Must never be logged. */
  token: string;
  expiresAt: string;
}

export interface RuntimePublicationCandidate {
  id: string;
  contentHash: string;
  /** Opaque, non-secret adapter state required to restore the candidate. */
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RuntimeResourcePublication {
  generation: number;
  revision: number;
  workspaceCandidate: RuntimePublicationCandidate;
  outputCandidate: RuntimePublicationCandidate | null;
  /** Provider-aware process checkpoint, when the composition can create one. */
  runtimeCheckpoint?: RuntimeCheckpointRef | null;
}
