import { describe, expect, it } from "vitest";
import {
  encodeGuiInterrupt,
  encodeGuiToolConfirmation,
  encodeGuiUserMessage,
  ingestManagedWireEvent,
} from "./managed-event-bridge";

describe("ingestManagedWireEvent", () => {
  it("maps null processed_at user.message to turn.queued without exposing processed_at", () => {
    const gui = ingestManagedWireEvent(
      {
        id: "sevt_1",
        type: "user.message",
        content: [{ type: "text", text: "hello" }],
        processed_at: null,
      },
      { sessionId: "sess_1" },
    );
    expect(gui).toMatchObject({
      type: "turn.queued",
      id: "sevt_1",
      delivery: "queued",
    });
    expect(gui).not.toHaveProperty("processed_at");
    expect((gui as { data?: { processed_at?: unknown } }).data?.processed_at).toBeUndefined();
  });

  it("maps stamped user.message to delivery processed", () => {
    const gui = ingestManagedWireEvent(
      {
        id: "sevt_1",
        type: "user.message",
        content: [{ type: "text", text: "hello" }],
        processed_at: "2026-10-31T12:00:00.000Z",
      },
      { sessionId: "sess_1" },
    );
    expect(gui).toMatchObject({
      type: "user.message",
      id: "sevt_1",
      delivery: "processed",
    });
    expect(gui).not.toHaveProperty("processed_at");
  });
});

describe("encodeGuiUserMessage / encodeGuiInterrupt / encodeGuiToolConfirmation", () => {
  it("encodes OpenMA user.message to CMA wire without delivery fields", () => {
    const result = encodeGuiUserMessage({
      sessionId: "sess_1",
      content: [{ type: "text", text: "hi" }],
      text: "hi",
      eventId: "local-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wire).toEqual({
      type: "user.message",
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("encodes interrupt", () => {
    const result = encodeGuiInterrupt({
      sessionId: "sess_1",
      sessionThreadId: "thread-7",
      eventId: "local-int-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wire).toMatchObject({
      type: "user.interrupt",
      session_thread_id: "thread-7",
    });
  });

  it("encodes tool confirmation allow/deny to user.tool_confirmation", () => {
    const allow = encodeGuiToolConfirmation({
      sessionId: "sess_1",
      toolUseId: "tool_ask",
      result: "allow",
      eventId: "local-confirm-1",
    });
    expect(allow.ok).toBe(true);
    if (!allow.ok) return;
    expect(allow.wire).toEqual({
      type: "user.tool_confirmation",
      tool_use_id: "tool_ask",
      result: "allow",
    });

    const deny = encodeGuiToolConfirmation({
      sessionId: "sess_1",
      toolUseId: "tool_ask",
      result: "deny",
      denyMessage: "too risky",
      eventId: "local-confirm-2",
    });
    expect(deny.ok).toBe(true);
    if (!deny.ok) return;
    expect(deny.wire).toEqual({
      type: "user.tool_confirmation",
      tool_use_id: "tool_ask",
      result: "deny",
      deny_message: "too risky",
    });
  });
});

it.each(["session.thread_created", "session.thread_status_running", "session.thread_status_idle", "session.thread_status_terminated"])("keeps %s discoverable after the real common vendor codec", type => {
  const gui=ingestManagedWireEvent({id:"thread-event",type,session_thread_id:"acp:claude:task",parent_thread_id:"sthr_primary",agent_name:"Researcher",processed_at:"2026-11-10T00:00:00Z"},{sessionId:"session"});
  expect(gui).toMatchObject({type,session_thread_id:"acp:claude:task",parent_thread_id:"sthr_primary",agent_name:"Researcher"});
  expect(gui).not.toHaveProperty("processed_at");
});

it("keeps unknown extension names wrapped rather than promoting arbitrary vendor types", () => {
  expect(ingestManagedWireEvent({id:"future",type:"session.thread_future",session_thread_id:"child"},{sessionId:"session"})).toMatchObject({type:"raw.event"});
});
