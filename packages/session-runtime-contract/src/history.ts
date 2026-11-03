// Types moved to @openma/core (#434); the codecs below stay with the contract.
import type { SessionEventView } from "@open-managed-agents/domain/sessions";
import type { SessionEventSourcePosition } from "@openma/core/runtime/history";
export type * from "@openma/core/runtime/history";

/** Storage metadata is internal and must never become a public Managed event field. */
export function encodeSessionEventDocument(
  event: SessionEventView,
  position: SessionEventSourcePosition,
  executionId?: string,
): string {
  if (!Number.isSafeInteger(position.revision) || position.revision < 1 || !Number.isSafeInteger(position.index) || position.index < 0) {
    throw new Error('Invalid session event source position');
  }
  return JSON.stringify({
    ...event,
    source_position: { ...position, ...(executionId === undefined ? {} : { execution_id: executionId }) },
  });
}

export function decodeSessionEventDocument(document: string): {
  event: SessionEventView;
  position?: SessionEventSourcePosition;
  executionId?: string;
} {
  const { source_position: source, ...event } = JSON.parse(document) as SessionEventView & {
    source_position?: { revision?: unknown; index?: unknown; execution_id?: unknown };
  };
  const valid = source !== null && typeof source === 'object' &&
    typeof source.revision === 'number' && Number.isSafeInteger(source.revision) && source.revision >= 1 &&
    typeof source.index === 'number' && Number.isSafeInteger(source.index) && source.index >= 0;
  if (!valid) return { event: event as SessionEventView };
  return {
    event: event as SessionEventView,
    position: { revision: source.revision as number, index: source.index as number },
    ...(typeof source.execution_id === 'string' && source.execution_id.length > 0 ? { executionId: source.execution_id } : {}),
  };
}

/** Model-facing result for a dispatched tool whose completion cannot be confirmed.
 * Keep the ordinary tool-result envelope; unknown is not a success or a retry instruction. */
export const UNKNOWN_TOOL_RESULT_TEXT = "Execution outcome is unknown: execution was interrupted, so completion cannot be confirmed. The operation may have taken effect. Verify the current state before repeating it.";
