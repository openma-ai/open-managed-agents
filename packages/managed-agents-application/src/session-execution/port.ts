import type {
  SentSessionEvent,
  SessionEventView,
} from "../domain/session-event";
import type { Session } from "../domain/session";
import type { SessionBootstrapEvent } from "../domain/session-bootstrap";
import type { ProjectionEventIdCollision } from "./projection-persistence";

/**
 * Application-owned projection proof. It is deliberately structural so the
 * execution coordinator can provide its fence without making this inbound
 * port depend on a runtime/storage package.
 */
export interface SessionExecutionFence {
  executionId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  expiresAt: string;
  /** Recover only this failed attempt; persistence must reject newer work atomically. */
  settlement?: "failed" | "failed_unclaimed";
}

/**
 * Ownership proof carried by a self-hosted Environment Work executor.
 * `generation` changes only when Work is claimed or reclaimed; heartbeats
 * extend the lease without changing it. Persistence validates this proof in
 * the same transaction that appends runtime events.
 */
export interface EnvironmentWorkExecutionFence {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  generation: number;
}

export type RuntimeProducedSessionEvent = Exclude<
  SessionEventView,
  SentSessionEvent
>;

/** Runtime host envelope only; ACP payload remains uninterpreted until the shared projector. */
export type RawSessionHostEvent =
  | { type: "session.ready"; sessionId: string; acpSessionId: string }
  | { type: "session.event"; sessionId: string; turnId: string; event: unknown }
  | { type: "session.complete"; sessionId: string; turnId: string }
  | { type: "session.error"; sessionId: string; turnId?: string; message: string }
  | { type: "session.disposed"; sessionId: string }
  | { type: "session.warning"; sessionId: string; source: "acp_semantic_recovery"; message: string; details: { reason: "native-state-missing" | "native-state-stale" } };

export interface RawRuntimePublication {
  seq: number;
  event: RawSessionHostEvent;
}

/** The projector is supplied by the control-plane composition, never by the worker. */
export interface RawRuntimeProjectorPort {
  project(state: string | null, event: RawSessionHostEvent): {
    state: string;
    events: RuntimeProducedSessionEvent[];
  };
}

export interface RecordRawSessionRuntimeEventsCommand {
  sessionId: string;
  events: RawRuntimePublication[];
  environmentWorkFence: EnvironmentWorkExecutionFence;
}

export type RecordRawSessionRuntimeEventsResult =
  | { type: "recorded"; events: RuntimeProducedSessionEvent[] }
  | { type: "invalid_request"; message: string }
  | Exclude<RecordSessionRuntimeEventsResult, { type: "recorded" }>;

export interface RecordSessionRuntimeEventsCommand {
  sessionId: string;
  events: RuntimeProducedSessionEvent[];
  executionFence?: SessionExecutionFence;
  environmentWorkFence?: EnvironmentWorkExecutionFence;
}

export type RecordSessionRuntimeEventsResult =
  | { type: "recorded"; session: Session }
  | { type: "not_found" }
  | { type: "execution_fence_lost" }
  | { type: "version_conflict"; message: string }
  | ProjectionEventIdCollision;

export interface SessionRuntimeProjectionApplicationPort {
  recordRawSessionRuntimeEvents?(command: RecordRawSessionRuntimeEventsCommand): Promise<RecordRawSessionRuntimeEventsResult>;
  recordSessionRuntimeEvents(
    command: RecordSessionRuntimeEventsCommand,
  ): Promise<RecordSessionRuntimeEventsResult>;
}

export interface LoadSessionRuntimeHistoryQuery {
  sessionId: string;
}

/** Application view of an event's stable place in the Session history. */
export interface SessionRuntimeHistoryEventView {
  event: SessionEventView;
  position: {
    revision: number;
    index: number;
  };
  executionId?: string;
  consumedByExecutionId?: string;
}

export type LoadSessionRuntimeHistoryResult =
  | {
      type: "found";
      /** Native Session revision from the same history snapshot. */
      revision?: number;
      initialEvents: SessionBootstrapEvent[];
      orderedInitialEvents?: SessionRuntimeHistoryEventView[];
      events: SessionEventView[];
      orderedEvents?: SessionRuntimeHistoryEventView[];
    }
  | { type: "not_found" };

export interface SessionRuntimeHistoryApplicationPort {
  loadSessionRuntimeHistory(
    query: LoadSessionRuntimeHistoryQuery,
  ): Promise<LoadSessionRuntimeHistoryResult>;
}
