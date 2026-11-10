import type { Session } from "../domain/session";
import type { StoredSession } from "@open-managed-agents/session-store";
import type {
  EnvironmentWorkExecutionFence,
  RuntimeProducedSessionEvent,
  SessionExecutionFence,
  WorkRuntimeRootProof,
} from "./port";

export interface FindRuntimeProjectionSession {
  workspaceId: string;
  sessionId: string;
}

export interface ProjectSessionRuntimeState extends FindRuntimeProjectionSession {
  expectedRevision: number;
  events: RuntimeProducedSessionEvent[];
  /** Original Work publication, before usage/budget/failure normalization.
   * Persist alongside the facts so response-loss replay is state-independent. */
  sourceEvents?: RuntimeProducedSessionEvent[];
  next: Session;
  executionFence?: SessionExecutionFence;
  environmentWorkFence?: EnvironmentWorkExecutionFence;
  workFinalization?: WorkFinalizationProjectionGuard;
  workRoot?: WorkRuntimeRootProof;
  workRootDialect?: "sqlite" | "postgres" | "mysql";
}

/**
 * A runtime projection replay reused an already-recorded event ID with a
 * different body (for example the same toolCallId with a new processed_at).
 * Event IDs are immutable facts: the first recorded body is kept and the
 * replayed batch is not applied. Every host (CF and Node) shares this result.
 */
export interface ProjectionEventIdCollision {
  _tag: "ProjectionEventIdCollision";
  ok: false;
  reason: "collision";
  type: "event_id_collision";
  kept: "first";
  eventIds: string[];
}

export function projectionEventIdCollision(
  eventIds: string[],
): ProjectionEventIdCollision {
  return {
    _tag: "ProjectionEventIdCollision",
    ok: false,
    reason: "collision",
    type: "event_id_collision",
    kept: "first",
    eventIds: [...eventIds],
  };
}

/** Structured warning every projection persistence emits on a collision. */
export function projectionEventIdCollisionWarning(input: {
  workspaceId: string;
  sessionId: string;
  collision: ProjectionEventIdCollision;
}): ProjectionEventIdCollision & {
  op: "session_runtime_projection.event_id_collision";
  workspaceId: string;
  sessionId: string;
} {
  return {
    ...input.collision,
    op: "session_runtime_projection.event_id_collision",
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  };
}

export type ProjectSessionRuntimeStateResult =
  | { type: "projected"; record: StoredSession }
  | ProjectionEventIdCollision
  | { type: "not_found" }
  | { type: "execution_fence_lost" }
  | { type: "revision_conflict"; actualRevision: number };

export interface SessionRuntimeProjectionPersistencePort {
  findCurrent(
    input: FindRuntimeProjectionSession,
  ): Promise<StoredSession | null>;
  project(
    input: ProjectSessionRuntimeState,
  ): Promise<ProjectSessionRuntimeStateResult>;
}

/** Additional CAS evidence for Work finalization only. Kept on the existing
 * projection transaction, not a second terminal/receipt ledger. */
export interface WorkFinalizationProjectionGuard {
  holder: string;
  turnId: string;
  inputId: string;
  inputDocument: string;
  bootstrapSequence?: number;
  dialect: "sqlite" | "postgres" | "mysql";
}

export { inspectWorkApprovalResolution, type WorkApprovalResolutionInput, type WorkApprovalResolution } from "./work-approval-resolution";

export { validateWorkThreadLineage } from "./work-thread-lineage";
