import { describe, expect, it } from "vitest";
import { subagentWireFrame, type SubagentEvent } from "../src/index.js";

type Agent = { name: string };
const thread = {
  id: "sthr_child",
  parentThreadId: "sthr_primary",
  agentId: "agent_child",
  agentName: "Child",
  agent: { name: "Child" },
  archived: false,
};
const frame = (event: SubagentEvent<Agent>) => subagentWireFrame(event);

// Field names are the official AMA thread events
// (BetaManagedAgentsSessionThreadCreatedEvent, ...AgentThreadMessage{Sent,Received}Event,
// ...SessionThreadStatus{Running,Idle,Terminated}Event). A frame outside that
// shape made GET /v1/sessions/:id/events reject the whole page with a 500.
describe("subagentWireFrame", () => {
  it("encodes thread creation on the child thread", () => {
    expect(frame({ type: "thread_created", thread, parentToolUseId: "toolu_1", instructions: "Be brief." })).toEqual({
      threadId: "sthr_child",
      frame: {
        type: "session.thread_created",
        agent_name: "Child",
        parent_thread_id: "sthr_primary",
        parent_tool_use_id: "toolu_1",
        content: [{ type: "text", text: "Be brief." }],
      },
    });
    expect(frame({ type: "thread_created", thread }).frame).toEqual({
      type: "session.thread_created",
      agent_name: "Child",
      parent_thread_id: "sthr_primary",
    });
  });

  it("encodes the message pair with official thread fields", () => {
    expect(frame({ type: "message_sent", id: "sevt_1", fromThreadId: "sthr_primary", toThreadId: "sthr_child", toAgentName: "Child", text: "Go" })).toEqual({
      threadId: "sthr_primary",
      frame: {
        id: "sevt_1",
        type: "agent.thread_message_sent",
        to_session_thread_id: "sthr_child",
        to_agent_name: "Child",
        content: [{ type: "text", text: "Go" }],
      },
    });
    expect(frame({ type: "message_received", threadId: "sthr_child", fromThreadId: "sthr_primary", fromAgentName: "Parent", fromMessageId: "sevt_1", text: "Go" })).toEqual({
      threadId: "sthr_child",
      frame: {
        type: "agent.thread_message_received",
        from_session_thread_id: "sthr_primary",
        from_agent_name: "Parent",
        from_message_id: "sevt_1",
        content: [{ type: "text", text: "Go" }],
      },
    });
  });

  it("encodes thread statuses and a child error", () => {
    expect(frame({ type: "thread_running", threadId: "sthr_child", agentName: "Child" })).toEqual({
      threadId: "sthr_child",
      frame: { type: "session.thread_status_running", agent_name: "Child" },
    });
    expect(frame({ type: "thread_idle", threadId: "sthr_child", agentName: "Child", stopReason: "end_turn", interrupted: false }).frame).toEqual({
      type: "session.thread_status_idle", agent_name: "Child", stop_reason: { type: "end_turn" },
    });
    expect(frame({ type: "thread_idle", threadId: "sthr_child", agentName: "Child", stopReason: "end_turn", interrupted: true }).frame).toEqual({
      type: "session.thread_status_idle", agent_name: "Child", stop_reason: { type: "end_turn" }, interrupted: true,
    });
    expect(frame({ type: "thread_error", threadId: "sthr_child", message: "boom" })).toEqual({
      threadId: "sthr_child",
      frame: { type: "session.error", error: { type: "unknown_error", retry_status: "exhausted", message: "boom" } },
    });
    expect(frame({ type: "thread_terminated", threadId: "sthr_child", agentName: "Child" })).toEqual({
      threadId: "sthr_child",
      frame: { type: "session.thread_status_terminated", agent_name: "Child" },
    });
  });
});
