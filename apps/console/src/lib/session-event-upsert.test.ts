import { describe, expect, it } from "vitest";
import { eventKey } from "./session-event-key";
import { upsertSessionEvent } from "./session-event-upsert";

type GuiEvent = Record<string, unknown> & {
  type: string;
  id?: string;
  delivery?: "queued" | "processed";
  content?: unknown;
};

function queuedUserMessage(id: string, text: string): GuiEvent {
  return {
    type: "turn.queued",
    id,
    content: [{ type: "text", text }],
    delivery: "queued",
  };
}

function processedUserMessage(id: string, text: string): GuiEvent {
  return {
    type: "user.message",
    id,
    content: [{ type: "text", text }],
    delivery: "processed",
  };
}

describe("upsertSessionEvent", () => {
  it("appends an unseen event", () => {
    const first = queuedUserMessage("sevt_1", "hello");
    const result = upsertSessionEvent([], first);

    expect(result.action).toBe("append");
    expect(result.events).toEqual([first]);
  });

  it("re-positions when turn.queued upgrades to user.message (delivery processed)", () => {
    const queued = queuedUserMessage("sevt_1", "hello");
    const after = queuedUserMessage("sevt_2", "second");
    const processed = processedUserMessage("sevt_1", "hello");

    const stored = [queued, after];
    const result = upsertSessionEvent(stored, processed);

    expect(result.action).toBe("update");
    expect(result.events.map(eventKey)).toEqual([eventKey(after), eventKey(processed)]);
    expect(result.events[0]).toBe(after);
    expect(result.events[1]).toBe(processed);
    expect((result.events[1] as GuiEvent).delivery).toBe("processed");
    expect((result.events[1] as GuiEvent).type).toBe("user.message");
  });

  it("dedupes an identical event without allocating or moving it", () => {
    const event = queuedUserMessage("sevt_1", "hello");
    const stored = [event];
    const result = upsertSessionEvent(stored, { ...event });

    expect(result.action).toBe("duplicate");
    expect(result.events).toBe(stored);
    expect(result.events[0]).toBe(event);
  });

  it("does not downgrade a processed event when a queued echo arrives late", () => {
    const processed = processedUserMessage("sevt_1", "hello");
    const stored = [processed];
    const result = upsertSessionEvent(stored, queuedUserMessage("sevt_1", "hello"));

    expect(result.action).toBe("duplicate");
    expect(result.events).toBe(stored);
    expect((result.events[0] as GuiEvent).delivery).toBe("processed");
  });

  it("keeps content-fallback matching for legacy events without ids", () => {
    const first: GuiEvent = {
      type: "turn.queued",
      content: [{ type: "text", text: "legacy" }],
      delivery: "queued",
    };
    const processed: GuiEvent = {
      type: "user.message",
      content: [{ type: "text", text: "legacy" }],
      delivery: "processed",
    };

    const result = upsertSessionEvent([first], processed);

    expect(result.action).toBe("update");
    expect(result.events).toEqual([processed]);
  });
});
