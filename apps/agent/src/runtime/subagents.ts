// Cloudflare adapter pieces for @open-managed-agents/session-subagents
// (#545 §0.7). SessionDO composes them in `runSubAgent`; the orchestration
// (thread lifecycle, statuses, delegate contract) is the domain package.
//
// Cloudflare keeps its existing wire for child lanes: `session.thread_created`
// (with `agent_id`) on the parent log and `session.thread_idle` when the
// child settles. The other official thread events are not on the Cloudflare
// wire yet; projections, lane status and the console read these two.

import type { SessionEvent } from "@open-managed-agents/shared";
import type { SubagentEvent } from "@open-managed-agents/session-subagents";

/** The Cloudflare wire event for a domain thread event, or null when none. */
export function cloudflareSubagentWireEvent<Agent>(event: SubagentEvent<Agent>): SessionEvent | null {
  switch (event.type) {
    case "thread_created":
      return {
        type: "session.thread_created",
        session_thread_id: event.thread.id,
        agent_id: event.thread.agentId,
        agent_name: event.thread.agentName,
        parent_thread_id: event.thread.parentThreadId,
      } as SessionEvent;
    case "thread_idle":
      return { type: "session.thread_idle", session_thread_id: event.threadId } as SessionEvent;
    default:
      return null;
  }
}

/** A Cloudflare thread id: `sthr_` (AMA BetaManagedAgentsSessionThread.id). */
export function cloudflareSubagentThreadId(): string {
  return `sthr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
