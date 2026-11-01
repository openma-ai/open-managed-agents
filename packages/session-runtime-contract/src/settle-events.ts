/**
 * Claude Managed Agents settle-only gate: while idle with
 * `stop_reason: requires_action` (outstanding event_ids) or
 * `budget_reached`, only settle events are accepted; `user.message` is 400.
 * Owner lock t307u — match official CMA (skills Message queuing / S1).
 */

export const SETTLE_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.tool_confirmation",
  "user.tool_result",
  "user.custom_tool_result",
  "user.interrupt",
]);

export type SettleOnlyReason = "requires_action" | "budget_reached";

export function isSettleSessionEventType(type: string): boolean {
  return SETTLE_SESSION_EVENT_TYPES.has(type);
}

type Wireish = { type?: string; [key: string]: unknown };

function threadIdOf(event: Wireish): string {
  const camel = event.sessionThreadId;
  const snake = event.session_thread_id;
  if (typeof camel === "string" && camel.length > 0) return camel;
  if (typeof snake === "string" && snake.length > 0) return snake;
  return "sthr_primary";
}

function stopReasonOf(event: Wireish): { type?: string; eventIds?: string[] } | null {
  const raw = (event.stopReason ?? event.stop_reason) as
    | { type?: string; eventIds?: unknown; event_ids?: unknown }
    | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const ids = Array.isArray(raw.eventIds)
    ? raw.eventIds
    : Array.isArray(raw.event_ids)
      ? raw.event_ids
      : [];
  return {
    type: typeof raw.type === "string" ? raw.type : undefined,
    eventIds: ids.filter((id): id is string => typeof id === "string"),
  };
}

function answeredToolCallIds(events: readonly Wireish[]): Set<string> {
  const answered = new Set<string>();
  for (const e of events) {
    const id =
      e.type === "agent.tool_result" ? (e.toolUseId ?? e.tool_use_id)
      : e.type === "agent.mcp_tool_result" ? (e.mcpToolUseId ?? e.mcp_tool_use_id)
      : e.type === "user.custom_tool_result" ? (e.customToolUseId ?? e.custom_tool_use_id)
      : e.type === "user.tool_confirmation" ? (e.toolUseId ?? e.tool_use_id)
      : e.type === "user.tool_result" ? (e.toolUseId ?? e.tool_use_id)
      : undefined;
    if (typeof id === "string") answered.add(id);
  }
  return answered;
}

/**
 * When the lane's latest session.status_* is idle with requires_action
 * (outstanding ids) or budget_reached, return that reason; else null.
 * Accepts domain camelCase or wire snake_case history events.
 */
export function settleOnlyReason(
  events: readonly Wireish[],
  threadId = "sthr_primary",
): SettleOnlyReason | null {
  const mine = events.filter((e) => threadIdOf(e) === threadId);
  let last: Wireish | undefined;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const type = mine[i]?.type;
    if (typeof type === "string" && type.startsWith("session.status_")) {
      last = mine[i];
      break;
    }
  }
  if (last?.type !== "session.status_idle") return null;
  const stop = stopReasonOf(last);
  if (stop?.type === "budget_reached") return "budget_reached";
  if (stop?.type !== "requires_action") return null;
  const ids = stop.eventIds ?? [];
  if (ids.length === 0) return null;
  const answered = answeredToolCallIds(mine);
  const outstanding = ids.filter((id) => !answered.has(id));
  return outstanding.length > 0 ? "requires_action" : null;
}

/** Non-settle event types in a batch, for 400 messaging. */
export function nonSettleEventTypes(events: readonly { type: string }[]): string[] {
  return [...new Set(events.map((e) => e.type).filter((t) => !isSettleSessionEventType(t)))];
}

export function settleOnlyRejectMessage(reason: SettleOnlyReason, badTypes: string[]): string {
  const allowed = [...SETTLE_SESSION_EVENT_TYPES].join(", ");
  const bad = badTypes.length > 0 ? badTypes.join(", ") : "user.message";
  return reason === "budget_reached"
    ? `Session is paused at its budget (stop_reason: budget_reached); only settle events are accepted (${allowed}). Rejected: ${bad}`
    : `Session is waiting on you (stop_reason: requires_action); only settle events are accepted (${allowed}). Rejected: ${bad}`;
}
