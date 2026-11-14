import type {
  SessionBootstrapEvent,
  SessionEventView,
} from "@open-managed-agents/domain/sessions";

export interface LoadSessionRuntimeHistoryRecord {
  workspaceId: string;
  sessionId: string;
}

export interface SessionRuntimeHistoryRecord {
  /** Native Session revision read in the same snapshot as this history. */
  revision?: number;
  initialEvents: SessionBootstrapEvent[];
  orderedInitialEvents?: OrderedSessionEvent[];
  events: SessionEventView[];
  /** Present only when every persisted event has a unique, trusted source position. */
  orderedEvents?: OrderedSessionEvent[];
}

export interface SessionRuntimeHistorySourcePort {
  load(
    input: LoadSessionRuntimeHistoryRecord,
  ): Promise<SessionRuntimeHistoryRecord | null>;
}

/** Position assigned atomically by the existing Session revision CAS. */
export interface SessionEventSourcePosition {
  revision: number;
  index: number;
}

export interface OrderedSessionEvent {
  event: SessionEventView;
  position: SessionEventSourcePosition;
  executionId?: string;
  consumedByExecutionId?: string;
}

export interface SessionEventEnvironmentWorkSource {
  workId: string;
  generation: number;
}

/** Storage metadata is internal and must never become a public Managed event field. */
export function encodeSessionEventDocument(
  event: SessionEventView,
  position: SessionEventSourcePosition,
  executionId?: string,
  consumedByExecutionId?: string,
  environmentWork?: SessionEventEnvironmentWorkSource,
): string {
  if (!Number.isSafeInteger(position.revision) || position.revision < 1 || !Number.isSafeInteger(position.index) || position.index < 0) {
    throw new Error('Invalid session event source position');
  }
  return JSON.stringify({
    ...event,
    source_position: { ...position, ...(executionId === undefined ? {} : { execution_id: executionId }), ...(consumedByExecutionId === undefined ? {} : { consumed_by_execution_id: consumedByExecutionId }), ...(environmentWork === undefined ? {} : { environment_work: environmentWork }) },
  });
}

export function decodeSessionEventDocument(document: string): {
  event: SessionEventView;
  position?: SessionEventSourcePosition;
  executionId?: string;
  consumedByExecutionId?: string;
  environmentWork?: SessionEventEnvironmentWorkSource;
} {
  const { source_position: source, ...event } = JSON.parse(document) as SessionEventView & {
    source_position?: { revision?: unknown; index?: unknown; execution_id?: unknown; consumed_by_execution_id?: unknown; environment_work?: { workId?: unknown; generation?: unknown } };
  };
  const valid = source !== null && typeof source === 'object' &&
    typeof source.revision === 'number' && Number.isSafeInteger(source.revision) && source.revision >= 1 &&
    typeof source.index === 'number' && Number.isSafeInteger(source.index) && source.index >= 0;
  if (!valid) return { event: event as SessionEventView };
  return {
    event: event as SessionEventView,
    ...(typeof source.consumed_by_execution_id === 'string' && source.consumed_by_execution_id.length > 0 ? { consumedByExecutionId: source.consumed_by_execution_id } : {}),
    position: { revision: source.revision as number, index: source.index as number },
    ...(typeof source.environment_work?.workId === "string" && source.environment_work.workId.length > 0 &&
      Number.isSafeInteger(source.environment_work.generation) && Number(source.environment_work.generation) > 0
      ? { environmentWork: { workId: source.environment_work.workId, generation: Number(source.environment_work.generation) } } : {}),
    ...(typeof source.execution_id === 'string' && source.execution_id.length > 0 ? { executionId: source.execution_id } : {}),
  };
}

/** The existing event-log visibility rule for all model/recovery projections.
 * Raw CF history includes queued/cancelled rows for UI reconciliation. */
export function isRuntimeHistoryEventVisible(event: object): boolean {
  const row = event as { deferredUntilToolResults?: string[]; deferred_until_tool_results?: string[]; _queued?: boolean; cancelled_at_ms?: number; processed_at?: string | null; processedAt?: string | null };
  // Missing stamps remain valid for legacy/in-memory events; explicit null
  // is the canonical accepted-but-not-consumed marker on both wire shapes.
  return row.deferredUntilToolResults === undefined && row.deferred_until_tool_results === undefined && row._queued !== true && row.cancelled_at_ms == null && row.processed_at !== null && row.processedAt !== null;
}

/** Model-facing result for a dispatched tool whose completion cannot be confirmed.
 * Keep the ordinary tool-result envelope; unknown is not a success or a retry instruction. */
export const UNKNOWN_TOOL_RESULT_TEXT = "interrupted: the execution was lost before this tool finished; it was not re-run automatically";
