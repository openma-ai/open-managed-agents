import { UNKNOWN_TOOL_RESULT_TEXT } from "@open-managed-agents/session-runtime-contract/history";
import type { SessionEvent } from "@open-managed-agents/shared";

/**
 * Codex-style history repair (codex-rs context_manager/normalize.rs): a
 * tool_use that never got a result but is followed by user.interrupt or a
 * later user.message was cut off by an interrupt. Insert the same synthetic
 * `agent.tool_result {is_error, "Cancelled by user"}` the interrupt handler
 * emits, right before that boundary, so the next model request always has
 * valid tool_use/tool_result pairing. A trailing unanswered tool_use (still
 * genuinely pending in requires_action) is left alone.
 */
/** Official CMA (session-threads): text of the error result that closes a
 * pending tool call on interrupt. */
export const INTERRUPTED_TOOL_RESULT_TEXT = UNKNOWN_TOOL_RESULT_TEXT;

/**
 * Shared core (CF SessionDO + Node runner): events to append when a
 * user.interrupt lands on a thread parked in requires_action. Official CMA
 * (session-threads): each pending tool call is closed with an error result
 * whose text is INTERRUPTED_TOOL_RESULT_TEXT and the thread re-emits
 * session.status_idle end_turn without sampling the model. Returns [] when the
 * thread is not parked (a running turn closes itself; idle is a no-op).
 * Synchronous calls only: anything that already returned is untouched.
 */
/**
 * Official CMA (managed-agents-events.md § Interrupt): "Against an
 * already-idle session an interrupt is normally a no-op." While idle with
 * stop_reason requires_action that means: accept the interrupt (202), leave
 * outstanding event_ids / pendingConfirmations / stop_reason alone, and do
 * not emit synthetic tool_results or a fresh idle end_turn. The only
 * documented exception is a self-hosted worker that failed its claimed work
 * item (re-queue); that path is not this helper.
 *
 * Shared CF SessionDO / Node runner core — returns no frames.
 */
export function interruptRequiresActionClosure(
  _events: SessionEvent[],
  _threadId = "sthr_primary",
): SessionEvent[] {
  return [];
}

// Model-history repair (not the wire path). Official CMA: interrupt against
// an already-idle session is a wire no-op (`interruptRequiresActionClosure`
// returns []). But DeepSeek Anthropic-compat requires every tool_use to be
// paired with a tool_result in the *immediately following* message — a
// user.message between tool_use and its real agent.tool_result yields 400
// ("unexpected tool_use_id found in tool_result blocks").
//
// Walk-order rules when building model history:
//   1) user.message with open calls → always synthesize interrupted results
//      *before* the message (and drop later real results for those ids). A
//      mid-open user.message cannot sit between tool_use and tool_result.
//   2) user.interrupt with open calls → synthesize only for ids that have
//      *no* later real agent.tool_result (running-turn abort). Ids that later
//      settle for real (idle requires_action interrupt is a wire no-op) stay
//      open so the real answer pairs immediately after the assistant turn.
//   3) trailing unanswered ids at end-of-log → synthesize.
//   4) duplicate agent.tool_result for an already-answered id → drop.
// See packages/agent-harness/test/history/interrupted-tool-calls.test.ts.
export function normalizeInterruptedToolCalls(events: SessionEvent[]): SessionEvent[] {
  const laterResultAt = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") {
      const id = (e as { tool_use_id?: string; mcp_tool_use_id?: string }).tool_use_id
        ?? (e as { mcp_tool_use_id?: string }).mcp_tool_use_id;
      if (id && !laterResultAt.has(id)) laterResultAt.set(id, i);
    }
  }

  let open: SessionEvent[] = [];
  const answered = new Set<string>();
  let changed = false;
  const out: SessionEvent[] = [];

  const synthOne = (use: SessionEvent) => {
    const id = (use as { id?: string }).id as string;
    const thread = (use as { session_thread_id?: string }).session_thread_id;
    out.push({
      type: use.type === "agent.mcp_tool_use" ? "agent.mcp_tool_result" : "agent.tool_result",
      ...(use.type === "agent.mcp_tool_use" ? { mcp_tool_use_id: id } : { tool_use_id: id }),
      content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
      is_error: true,
      ...(thread && thread !== "sthr_primary" ? { session_thread_id: thread } : {}),
    } as unknown as SessionEvent);
    answered.add(id);
    changed = true;
  };

  const closeOpen = (predicate: (use: SessionEvent) => boolean) => {
    if (open.length === 0) return;
    const keep: SessionEvent[] = [];
    for (const use of open) {
      if (predicate(use)) synthOne(use);
      else keep.push(use);
    }
    open = keep;
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    if (e.type === "user.message" && open.length > 0) {
      // Must pair before any user turn — later real answers are superseded
      // for sample shape (drop them when we reach them).
      closeOpen(() => true);
    } else if (e.type === "user.interrupt" && open.length > 0) {
      // Synth only ids with no later real result; settled-after-noop-interrupt
      // keeps the real answer.
      closeOpen((use) => {
        const id = (use as { id?: string }).id as string;
        const at = laterResultAt.get(id);
        return at == null || at <= i;
      });
    }

    if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") {
      const id = (e as { tool_use_id?: string; mcp_tool_use_id?: string }).tool_use_id
        ?? (e as { mcp_tool_use_id?: string }).mcp_tool_use_id;
      if (id && answered.has(id)) {
        changed = true;
        continue;
      }
      if (id) {
        answered.add(id);
        open = open.filter((use) => (use as { id?: string }).id !== id);
      }
      out.push(e);
      continue;
    }

    out.push(e);
    if (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use" || e.type === "agent.mcp_tool_use") {
      const id = (e as { id?: string }).id;
      if (id && !answered.has(id)) open.push(e);
    }
  }
  closeOpen(() => true);
  return changed ? out : events;
}
