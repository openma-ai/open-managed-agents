/**
 * Claude Managed Agents `requires_action` bookkeeping over wire (snake_case)
 * session events. Pure functions: CF SessionDO and the Node managed runner
 * share these semantics (CF still carries its own copy in apps/agent; moving it
 * here is tracked in #398 HANDOFF).
 *
 * - A thread is parked when its latest session.status_* is an idle with
 *   stop_reason requires_action; the outstanding calls are its event_ids minus
 *   those already answered/closed.
 * - Partial answers re-announce the remaining ids; all answered -> resume.
 */
type WireEvent = { type?: string; [key: string]: unknown };

const thread = (e: WireEvent) => (e.session_thread_id as string | undefined) ?? "sthr_primary";

/** Tool-call ids that have an answer or a closing result in `events`. */
export function answeredToolCallIds(events: readonly WireEvent[]): Set<string> {
  const answered = new Set<string>();
  for (const e of events) {
    const id = e.type === "agent.tool_result" ? e.tool_use_id
      : e.type === "agent.mcp_tool_result" ? e.mcp_tool_use_id
      : e.type === "user.custom_tool_result" ? e.custom_tool_use_id
      : e.type === "user.tool_confirmation" ? e.tool_use_id
      : undefined;
    if (typeof id === "string") answered.add(id);
  }
  return answered;
}

/** Outstanding ids of the parked requires_action idle, or null when the
 * thread is not parked. */
export function outstandingRequiresAction(
  events: readonly WireEvent[],
  threadId = "sthr_primary",
): string[] | null {
  const mine = events.filter((e) => thread(e) === threadId);
  const last = [...mine].reverse().find((e) => typeof e.type === "string" && e.type.startsWith("session.status_"));
  const stop = last?.stop_reason as { type?: string; event_ids?: unknown } | undefined;
  if (last?.type !== "session.status_idle" || stop?.type !== "requires_action") return null;
  const ids = Array.isArray(stop.event_ids) ? stop.event_ids.filter((id): id is string => typeof id === "string") : [];
  const answered = answeredToolCallIds(mine);
  return ids.filter((id) => !answered.has(id));
}

/** Drop pending calls already closed (steer/interrupt/answered) before parking
 * (CF 85d17d1 parity). */
export function stillPending(pending: readonly string[], events: readonly WireEvent[]): string[] {
  const answered = answeredToolCallIds(events);
  return [...new Set(pending)].filter((id) => !answered.has(id));
}

/** Every tool-call id that ever existed in the session (for 400 on unknown ids). */
export function knownToolCallIds(events: readonly WireEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if ((e.type === "agent.tool_use" || e.type === "agent.custom_tool_use" || e.type === "agent.mcp_tool_use")
      && typeof e.id === "string") ids.add(e.id);
  }
  return ids;
}
