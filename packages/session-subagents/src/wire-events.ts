// The official wire frame of each subagent domain event (AMA thread events:
// session.thread_created, agent.thread_message_{sent,received},
// session.thread_status_{running,idle,terminated}; a child error is a
// thread-tagged session.error). One encoding for every platform; the caller
// stamps `id` / `processed_at` and tags the frame with `threadId`.

import type { SubagentEvent } from "./subagents.js";

export interface SubagentWireFrame {
  /** The thread the frame belongs to (its `session_thread_id`). */
  threadId: string;
  /** Snake-case frame without `processed_at` / `session_thread_id`. */
  frame: Record<string, unknown> & { type: string };
}

const text = (value: string) => [{ type: "text", text: value }];

export function subagentWireFrame<Agent>(event: SubagentEvent<Agent>): SubagentWireFrame {
  switch (event.type) {
    case "thread_created":
      return { threadId: event.thread.id, frame: {
        type: "session.thread_created",
        agent_name: event.thread.agentName,
        parent_thread_id: event.thread.parentThreadId,
        ...(event.parentToolUseId !== undefined && { parent_tool_use_id: event.parentToolUseId }),
        ...(event.instructions !== undefined && { content: text(event.instructions) }),
      } };
    case "message_sent":
      return { threadId: event.fromThreadId, frame: {
        id: event.id,
        type: "agent.thread_message_sent",
        to_session_thread_id: event.toThreadId,
        to_agent_name: event.toAgentName,
        content: text(event.text),
      } };
    case "message_received":
      return { threadId: event.threadId, frame: {
        type: "agent.thread_message_received",
        from_session_thread_id: event.fromThreadId,
        from_agent_name: event.fromAgentName,
        from_message_id: event.fromMessageId,
        content: text(event.text),
      } };
    case "thread_running":
      return { threadId: event.threadId, frame: { type: "session.thread_status_running", agent_name: event.agentName } };
    case "thread_idle":
      return { threadId: event.threadId, frame: {
        type: "session.thread_status_idle",
        agent_name: event.agentName,
        stop_reason: { type: event.stopReason },
        ...(event.interrupted && { interrupted: true }),
      } };
    case "thread_error":
      return { threadId: event.threadId, frame: {
        type: "session.error",
        error: { type: "unknown_error", retry_status: "exhausted", message: event.message },
      } };
    case "thread_terminated":
      return { threadId: event.threadId, frame: { type: "session.thread_status_terminated", agent_name: event.agentName } };
  }
}
