import type { Session } from "../domain/session";
import type { StoredSession } from "@open-managed-agents/session-store";
import type {
  EnvironmentWorkExecutionFence,
  RuntimeProducedSessionEvent,
  SessionExecutionFence,
} from "./port";

export interface FindRuntimeProjectionSession {
  workspaceId: string;
  sessionId: string;
}

/** Internal Work checkpoint, not another authority or event ledger. */
export interface RuntimeRawProjectionCheckpoint {
  generation: number;
  seq: number;
  lastEvent: string;
  projectorState: string;
}

export interface FindRawRuntimeProjection extends FindRuntimeProjectionSession {
  environmentWorkFence: EnvironmentWorkExecutionFence;
}

export interface ProjectSessionRuntimeState extends FindRuntimeProjectionSession {
  rawProjection?: { expected: string | null; next: RuntimeRawProjectionCheckpoint };
  expectedRevision: number;
  events: RuntimeProducedSessionEvent[];
  next: Session;
  executionFence?: SessionExecutionFence;
  environmentWorkFence?: EnvironmentWorkExecutionFence;
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
  findRawProjection?(input: FindRawRuntimeProjection): Promise<{ type: "found"; checkpoint: RuntimeRawProjectionCheckpoint | null } | { type: "execution_fence_lost" }>;
  findCurrent(
    input: FindRuntimeProjectionSession,
  ): Promise<StoredSession | null>;
  project(
    input: ProjectSessionRuntimeState,
  ): Promise<ProjectSessionRuntimeStateResult>;
}
