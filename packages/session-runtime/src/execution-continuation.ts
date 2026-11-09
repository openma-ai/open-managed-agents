import { isRuntimeHistoryEventVisible, UNKNOWN_TOOL_RESULT_TEXT } from "@open-managed-agents/session-runtime-contract/history";
export const INTERRUPTED_EXECUTION_TOOL_RESULT = UNKNOWN_TOOL_RESULT_TEXT;
type Event = { type: string; id?: string; [key: string]: unknown };
/** Pure canonical-history rule, used before either platform resumes a harness. */
export function executionContinuationEvents(history: readonly Event[], input: { executionId: string; attempt: number; laneId: string }): Event[] {
  if (input.attempt < 2) return [];
  history = history.filter(isRuntimeHistoryEventVisible).filter(event => (event.session_thread_id ?? event.sessionThreadId ?? "sthr_primary") === input.laneId);
  const uses = new Map<string, Event>(), resolved = new Set<string>(), confirmed = new Set<string>(), ids = new Set(history.map(e => e.id));
  for (const event of history) {
    if ((event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use") && event.id) uses.set(event.id, event);
    const resultId = event.tool_use_id ?? event.toolUseId ?? event.mcp_tool_use_id ?? event.mcpToolUseId;
    if (typeof resultId !== "string") continue;
    if (event.type === "user.tool_confirmation") confirmed.add(resultId);
    else if (event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result") resolved.add(resultId);
  }
  const events: Event[] = [];
  const pendingRetryIds = new Set<string>();
  const retry = (id: string, use: Event) => {
    const retryId = "retry:" + id;
    const useIndex = history.findIndex(event => event.id === id);
    if (history.slice(useIndex + 1).some(event => event.type === "user.interrupt")) return;
    if (ids.has(retryId) || typeof use.name !== "string" || use.input === null || typeof use.input !== "object") return;
    if (!ids.has("unknown:" + id)) events.push({id:"unknown:"+id,type:"session.warning",source:"tool_outcome_unknown",session_thread_id:input.laneId,
      message:"Tool may have committed. Explicit authorization is required for another attempt.",
      details:{outcome:"dispatched_unknown",tool_use_id:id,retry_request_id:retryId}});
    events.push({...use,id:retryId,input:structuredClone(use.input),evaluated_permission:"ask",session_thread_id:input.laneId});
    ids.add(retryId);
  };
  for (let index = 0; index < history.length; index++) {
    const event = history[index]!;
    if (event.type !== "session.warning" || event.source !== "tool_outcome_unknown") continue;
    const details = event.details as Record<string, unknown> | undefined;
    if (details?.outcome !== "dispatched_unknown" || typeof details.retry_request_id !== "string") continue;
    const id = details.retry_request_id;
    pendingRetryIds.add(id);
    if (history.slice(index + 1).some(row => row.type === "user.interrupt")) continue;
    if (typeof details.tool_use_id === "string") {
      const use = uses.get(details.tool_use_id);
      if (use !== undefined) retry(details.tool_use_id, use);
    }
  }
  for (const [id, use] of uses) {
    if (resolved.has(id) || (pendingRetryIds.has(id) && !confirmed.has(id)) || ids.has("resume:" + input.executionId + ":" + id)) continue;
    retry(id, use);
    events.push({ id: "resume:" + input.executionId + ":" + id,
      type: use.type === "agent.mcp_tool_use" ? "agent.mcp_tool_result" : "agent.tool_result",
      ...(use.type === "agent.mcp_tool_use" ? { mcp_tool_use_id: id } : { tool_use_id: id }),
      session_thread_id: input.laneId, content: INTERRUPTED_EXECUTION_TOOL_RESULT, is_error: true });
  }
  const id = "resume:" + input.executionId + ":" + input.attempt;
  if (!ids.has(id)) events.push({ id, type: "session.warning", source: "execution_resumed", message: "Execution resumed after lease loss", details: { execution_id: input.executionId, attempt: input.attempt, reason: "lease_lost" }, session_thread_id: input.laneId });
  return events;
}
