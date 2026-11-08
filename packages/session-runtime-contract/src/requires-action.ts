/**
 * Claude Managed Agents `requires_action` bookkeeping over wire (snake_case)
 * Session events: one implementation for the Cloudflare SessionDO and the
 * Node managed runner (design §0.7).
 *
 * - A thread is parked when its latest session.status_* is an idle with
 *   stop_reason requires_action; the outstanding calls are its event_ids minus
 *   those already answered/closed.
 * - Partial answers re-announce the remaining ids; all answered -> resume.
 * - Settle-only 400 for user.message uses shared settleOnlyReason (t307u),
 *   including budget_reached when that idle stop exists.
 */
import { settleOnlyReason, settleOnlyRejectMessage } from "./settle-events";

type WireEvent = { type?: string; [key: string]: unknown };

/** Narrow history frames for requires_action bookkeeping without forcing
 *  callers to write `as unknown as` (banned by the runtime-adapter lint). */
export function asWireEvents(
  events: ReadonlyArray<{ readonly type?: string }>,
): WireEvent[] {
  return events as WireEvent[];
}

const thread = (e: WireEvent) => (e.session_thread_id as string | undefined) ?? "sthr_primary";

/** Tool-call ids that have an answer or a closing result in `events`. */
export function answeredToolCallIds(events: readonly WireEvent[]): Set<string> {
  const answered = new Set<string>();
  for (const e of events) {
    const id = e.type === "agent.tool_result" ? e.tool_use_id
      : e.type === "agent.mcp_tool_result" ? e.mcp_tool_use_id
      : e.type === "user.custom_tool_result" ? e.custom_tool_use_id
      : e.type === "user.tool_confirmation" ? e.tool_use_id
      : e.type === "user.tool_result" ? e.tool_use_id
      : undefined;
    if (typeof id === "string") answered.add(id);
  }
  return answered;
}

/** Tool-call ids that already have an agent.tool_result: the harness
 * transcript's answer. A second result for one tool_use makes the provider
 * reject the whole transcript, so a call listed here takes no more answers. */
export function toolResultIds(events: readonly WireEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type === "agent.tool_result" && typeof e.tool_use_id === "string") ids.add(e.tool_use_id);
  }
  return ids;
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

/** Built-in toolset calls: parked only for always_ask confirmation. */
const BUILTIN_TOOLS = new Set(["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"]);

/** A pending call the client must answer with user.custom_tool_result, by
 * its resolved tool name (a call proxied through mcp_invoke is named by its
 * target). Built-ins, MCP, sub-agent and memory tools await confirmation. */
export function awaitsCustomToolResult(toolName: string): boolean {
  return !BUILTIN_TOOLS.has(toolName)
    && !toolName.startsWith("mcp_")
    && !toolName.startsWith("call_agent_")
    && !toolName.startsWith("memory_");
}

export interface PendingToolCall {
  toolCallId: string;
  /** Resolved tool name (see awaitsCustomToolResult). */
  toolName: string;
}

/** The requires_action stop_reason announcing `eventIds`: custom_tool_result
 * when any pending call awaits a custom result, else tool_confirmation. */
export function requiresActionStopReason(pending: readonly PendingToolCall[], eventIds: readonly string[]): {
  type: "requires_action";
  action_type: "custom_tool_result" | "tool_confirmation";
  event_ids: string[];
} {
  return {
    type: "requires_action",
    action_type: pending.some((call) => awaitsCustomToolResult(call.toolName)) ? "custom_tool_result" : "tool_confirmation",
    event_ids: [...eventIds],
  };
}

/** Pending calls still open after `answeredId` was answered. With a parallel
 * batch, every call that already has a tool result in `events` is closed too;
 * a lone call is closed by its answer alone. */
export function remainingAfterAnswer<T extends { toolCallId: string }>(
  pending: readonly T[],
  answeredId: string,
  events: () => readonly WireEvent[],
): T[] {
  let resolved = new Set<string>([answeredId]);
  if (pending.length > 1) {
    try {
      for (const id of toolResultIds(events())) resolved.add(id);
    } catch {
      resolved = new Set([answeredId]);
    }
  }
  return pending.filter((call) => !resolved.has(call.toolCallId));
}

export const REQUIRES_ACTION_USER_MESSAGE_REJECT =
  settleOnlyRejectMessage("requires_action", ["user.message"]);

/**
 * Official CMA / t307u: while parked in requires_action or budget_reached,
 * a `user.message` is a 400. Returns a reject message, or null when the batch
 * is allowed (no park, or only settle events / interrupt).
 */
export function rejectMessageForRequiresActionBatch(
  events: readonly WireEvent[],
  batch: readonly WireEvent[],
  threadId = "sthr_primary",
): string | null {
  const reason = settleOnlyReason(events, threadId);
  if (reason === null) return null;
  if (batch.some((event) => event.type === "user.message")) {
    return settleOnlyRejectMessage(reason, ["user.message"]);
  }
  return null;
}
