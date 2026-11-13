type CallEvent = { type: string; id?: string; session_thread_id?: string; tool_use_id?: string; mcp_tool_use_id?: string };

/** A preparation error without a call can terminate a turn. Once a call is
 * open, only its result-delivery path may close it; preflight cannot fabricate
 * either a tool result or a Session terminal on the execution's behalf. */
export function hasOpenExecutionCall(events: readonly CallEvent[], threadId: string): boolean {
  const mine = events.filter(event => (event.session_thread_id ?? "sthr_primary") === threadId);
  const results = new Set(mine.flatMap(event => event.type === "agent.tool_result" && event.tool_use_id
    ? [event.tool_use_id] : event.type === "agent.mcp_tool_result" && event.mcp_tool_use_id ? [event.mcp_tool_use_id] : []));
  return mine.some(event => ["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"].includes(event.type)
    && typeof event.id === "string" && !results.has(event.id));
}
