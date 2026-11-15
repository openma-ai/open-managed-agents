// Cloudflare adapter pieces for @open-managed-agents/session-subagents
// (#545 §0.7). SessionDO composes them in `runSubAgent`; the orchestration
// (thread lifecycle, statuses, delegate contract) and the official wire frames
// (subagentWireFrame) are the domain package's.
//
// On top of the official frames Cloudflare keeps two child-lane extras its
// own readers still use: `agent_id` on `session.thread_created` and the
// legacy `session.thread_idle` after the child settles (console timeline,
// SessionDO lane bookkeeping). Neither is part of the public event page.

import type { SessionEvent } from "@open-managed-agents/shared";
import { subagentWireFrame, type SubagentEvent } from "@open-managed-agents/session-subagents";

/** The Cloudflare wire events of a domain thread event, in log order. */
export function cloudflareSubagentWireEvents<Agent>(event: SubagentEvent<Agent>): SessionEvent[] {
  const { threadId, frame } = subagentWireFrame(event);
  const official = {
    ...frame,
    session_thread_id: threadId,
    ...(event.type === "thread_created" && { agent_id: event.thread.agentId }),
  } as unknown as SessionEvent;
  if (event.type !== "thread_idle") return [official];
  return [official, { type: "session.thread_idle", session_thread_id: threadId } as SessionEvent];
}

/** A Cloudflare thread id: `sthr_` (AMA BetaManagedAgentsSessionThread.id). */
export function cloudflareSubagentThreadId(): string {
  return `sthr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
