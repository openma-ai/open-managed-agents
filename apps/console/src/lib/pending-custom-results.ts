import type { PendingManagedAction, WireSessionEvent } from "@openma/common/session-events/managed";

/** Canonical calls are actionable on receipt, independently of Session status. */
export function pendingCustomResults(events: readonly WireSessionEvent[], threadId: string): PendingManagedAction[] {
  const answered = new Set<string>();
  let closedAt = -Infinity;
  const calls = new Map<string, WireSessionEvent>();
  for (const source of events) {
    const data = source.data as Record<string, unknown> | undefined;
    const meta = data?.adapter_meta as Record<string, unknown> | undefined;
    const stop = (source.stop_reason ?? data?.stop_reason) as { type?: string } | undefined;
    if ((source.session_thread_id ?? "sthr_primary") === threadId &&
      (source.type === "session.terminated" || source.type === "session.status_terminated" ||
        ((source.type === "session.idle" || source.type === "session.status_idle") && stop?.type !== "requires_action"))) {
      const time = Date.parse(String(source.ts ?? ""));
      if (Number.isFinite(time)) closedAt = Math.max(closedAt, time);
    }
    // Console ingests CMA into OpenMA tool.started/completed before projection.
    const event = meta?.managed_event_type === "agent.custom_tool_use" && source.type === "tool.started"
      ? { ...source, type: "agent.custom_tool_use", name: data?.tool_name, input: data?.raw_input }
      : source;
    if ((source.type === "tool.completed" || source.type === "tool.failed") && typeof data?.tool_call_id === "string") answered.add(data.tool_call_id);
    if (event.type === "user.custom_tool_result" && typeof event.custom_tool_use_id === "string") answered.add(event.custom_tool_use_id);
    if (event.type === "agent.tool_result" && typeof event.tool_use_id === "string") answered.add(event.tool_use_id);
    // Deltas/previews never enter this set. Canonical input must be complete.
    if (event.type === "agent.custom_tool_use" && typeof event.id === "string" && event.id
      && typeof event.name === "string" && event.input !== null && typeof event.input === "object"
      && !Array.isArray(event.input) && (event.session_thread_id ?? "sthr_primary") === threadId) calls.set(event.id, event);
  }
  return [...calls].filter(([id, event]) => !answered.has(id) && !(Date.parse(String(event.ts ?? "")) <= closedAt)).map(([id, event]) => ({ id, event, type: "custom_result" }));
}
