import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { encodeRuntimeHistoryEvent, encodeRuntimeSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SentSessionEvent } from "@open-managed-agents/managed-agents-application";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { SessionRuntimeHistorySourcePort } from "@open-managed-agents/session-runtime-contract/history";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionEvent } from "@open-managed-agents/shared";

/** The event log is an admission log, not an execution transcript. Future
 * inputs may precede earlier executions' replies, so neither timestamps nor
 * slicing at the current input gives a safe semantic recovery boundary. */
export async function loadNodeManagedAcpRecoveryHistory(input: {
  sql: SqlClient;
  history: SessionRuntimeHistorySourcePort;
  fence: SessionExecutionFence;
  acceptedEvents: readonly SentSessionEvent[];
}): Promise<NonNullable<HarnessContext["acpRecoveryHistory"]>> {
  const { fence } = input;
  const rows = await input.sql.prepare(
    `SELECT id, events_json FROM managed_session_executions
       WHERE workspace_id = ? AND session_id = ? AND lane_id = 'sthr_primary'
         AND id <> ? AND state IN ('completed', 'failed', 'cancelled')
         AND attempt_count > 0`,
  ).bind(fence.workspaceId, fence.sessionId, fence.executionId)
    .all<{ id: string; events_json: string }>();
  const executions = new Set<string>();
  const consumedInputs = new Set<string>();
  for (const row of rows.results ?? []) {
    executions.add(row.id);
    for (const event of JSON.parse(row.events_json) as SentSessionEvent[]) consumedInputs.add(event.id);
  }
  // Explicit exclusion also covers inputs shared between execution batches.
  for (const event of input.acceptedEvents) consumedInputs.delete(event.id);
  const history = await input.history.load({ workspaceId: fence.workspaceId, sessionId: fence.sessionId });
  if (!history) throw new Error("Node ACP recovery history was not found");
  const initial = history.initialEvents.flatMap((event, index) =>
    consumedInputs.has(`bootstrap_${fence.sessionId}:${index}`)
      ? [encodeRuntimeSessionEvent(event) as SessionEvent] : []);
  const events = (history.orderedEvents ?? history.events.map(event => ({ event, executionId: undefined }))).flatMap(item => {
    const { event } = item;
    if ("sessionThreadId" in event && event.sessionThreadId && event.sessionThreadId !== "sthr_primary") return [];
    if (event.type.startsWith("user.") || event.type === "system.message") {
      if (!consumedInputs.has(event.id)) return [];
    } else if ("executionId" in item && item.executionId && !executions.has(item.executionId)) {
      return [];
    }
    return [encodeRuntimeHistoryEvent(event) as SessionEvent];
  });
  return [...initial, ...events];
}
