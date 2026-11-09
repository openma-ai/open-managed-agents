import { UNKNOWN_TOOL_RESULT_TEXT } from "@open-managed-agents/session-runtime-contract/history";
export const INTERRUPTED_EXECUTION_TOOL_RESULT = UNKNOWN_TOOL_RESULT_TEXT;
type Event = { type: string; id?: string; [key: string]: unknown };
/** Pure canonical-history rule, used before either platform resumes a harness. */
export function executionContinuationEvents(history: readonly Event[], input: { executionId: string; attempt: number; laneId: string }): Event[] {
  if (input.attempt < 2) return [];
  const uses = new Map<string, Event>(), resolved = new Set<string>(), ids = new Set(history.map(e => e.id));
  for (const event of history) {
    if ((event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use") && event.id) uses.set(event.id, event);
    const resultId = event.tool_use_id ?? event.toolUseId ?? event.mcp_tool_use_id ?? event.mcpToolUseId;
    if (typeof resultId === "string") resolved.add(resultId);
  }
  const events: Event[] = [];
  for (const [id, use] of uses) {
    if (resolved.has(id) || ids.has("resume:" + input.executionId + ":" + id)) continue;
    events.push({ id: "resume:" + input.executionId + ":" + id,
      type: use.type === "agent.mcp_tool_use" ? "agent.mcp_tool_result" : "agent.tool_result",
      ...(use.type === "agent.mcp_tool_use" ? { mcp_tool_use_id: id } : { tool_use_id: id }),
      session_thread_id: input.laneId, content: INTERRUPTED_EXECUTION_TOOL_RESULT, is_error: true });
  }
  const id = "resume:" + input.executionId + ":" + input.attempt;
  if (!ids.has(id)) events.push({ id, type: "session.warning", source: "execution_resumed", message: "Execution resumed after lease loss", details: { execution_id: input.executionId, attempt: input.attempt, reason: "lease_lost" }, session_thread_id: input.laneId });
  return events;
}
