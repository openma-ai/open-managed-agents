import { describe, expect, it } from "vitest";
import { reduceManagedDeltaFrame } from "./managed-stream";

describe("reduceManagedDeltaFrame", () => {
  it("correlates official event_start and event_delta frames", () => {
    let state = { kinds: new Map(), text: new Map() };

    state = reduceManagedDeltaFrame(state, {
      type: "event_start",
      event: { id: "msg_01", type: "agent.message" },
    }).state;
    const reduced = reduceManagedDeltaFrame(state, {
      type: "event_delta",
      event_id: "msg_01",
      delta: { type: "content_delta", content: { type: "text", text: "Hi" } },
    });

    expect(reduced.action).toEqual({
      type: "append",
      stream: "agent.message",
      id: "msg_01",
      text: "Hi",
    });
    expect(reduced.state.text.get("msg_01")).toBe("Hi");
  });

  it("keeps thinking deltas separate and closes on the canonical event", () => {
    let state = reduceManagedDeltaFrame(
      { kinds: new Map(), text: new Map() },
      {
        type: "event_start",
        event: { id: "think_01", type: "agent.thinking" },
      },
    ).state;
    state = reduceManagedDeltaFrame(state, {
      type: "event_delta",
      event_id: "think_01",
      delta: { type: "content_delta", content: { type: "text", text: "Reason" } },
    }).state;
    const reduced = reduceManagedDeltaFrame(state, {
      id: "think_01",
      type: "agent.thinking",
      processed_at: "2026-08-29T00:00:00.000Z",
    });

    expect(reduced.action).toEqual({
      type: "close",
      stream: "agent.thinking",
      id: "think_01",
    });
    expect(reduced.state.kinds.has("think_01")).toBe(false);
    expect(reduced.state.text.has("think_01")).toBe(false);
  });
});
