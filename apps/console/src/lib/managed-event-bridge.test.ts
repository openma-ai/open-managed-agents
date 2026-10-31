import { describe, expect, it } from "vitest";
import {
  encodeGuiInterrupt,
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

describe("encodeGuiUserMessage / encodeGuiInterrupt", () => {
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
});
