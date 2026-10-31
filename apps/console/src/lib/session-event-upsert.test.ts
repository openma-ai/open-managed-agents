import { describe, expect, it } from "vitest";
import { eventKey } from "./session-event-key";
import { upsertSessionEvent } from "./session-event-upsert";

type WireEvent = Record<string, unknown> & {
  type: string;
  id?: string;
  processed_at?: string | null;
  content?: unknown;
};

const PROCESSED_AT = "2026-10-31T12:00:00.000Z";

function queuedUserMessage(id: string, text: string): WireEvent {
  return {
    type: "user.message",
    id,
    content: [{ type: "text", text }],
    processed_at: null,
  };
}

describe("upsertSessionEvent", () => {
  it("appends an unseen event", () => {
    const first = queuedUserMessage("sevt_1", "hello");
    const result = upsertSessionEvent([], first);

    expect(result.action).toBe("append");
    expect(result.events).toEqual([first]);
  });

  it("re-positions a queued event to the end when processed_at becomes set", () => {
    const queued = queuedUserMessage("sevt_1", "hello");
    const after = queuedUserMessage("sevt_2", "second");
    const processed: WireEvent = {
      ...queued,
      processed_at: PROCESSED_AT,
    };

    const stored = [queued, after];
    const result = upsertSessionEvent(stored, processed);

    expect(result.action).toBe("update");
    // Stamped copy moves after events that arrived while it was queued.
    expect(result.events.map(eventKey)).toEqual([eventKey(after), eventKey(processed)]);
    expect(result.events[0]).toBe(after);
    expect(result.events[1]).toBe(processed);
    expect((result.events[1] as WireEvent).processed_at).toBe(PROCESSED_AT);
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
    const processed: WireEvent = {
      type: "user.message",
      id: "sevt_1",
      content: [{ type: "text", text: "hello" }],
      processed_at: PROCESSED_AT,
    };
    const stored = [processed];
    const result = upsertSessionEvent(stored, queuedUserMessage("sevt_1", "hello"));

    expect(result.action).toBe("duplicate");
    expect(result.events).toBe(stored);
    expect((result.events[0] as WireEvent).processed_at).toBe(PROCESSED_AT);
  });

  it("re-positions when processed_at changes again", () => {
    const first: WireEvent = {
      type: "user.message",
      id: "sevt_1",
      content: [{ type: "text", text: "hello" }],
      processed_at: PROCESSED_AT,
    };
    const second: WireEvent = {
      type: "user.message",
      id: "sevt_2",
      content: [{ type: "text", text: "later" }],
      processed_at: PROCESSED_AT,
    };
    const updated: WireEvent = {
      ...first,
      processed_at: "2026-10-31T12:00:01.000Z",
    };

    const result = upsertSessionEvent([first, second], updated);

    expect(result.action).toBe("update");
    expect(result.events[0]).toBe(second);
    expect(result.events[1]).toBe(updated);
  });

  it("keeps content-fallback matching for legacy events without ids", () => {
    const first: WireEvent = {
      type: "user.message",
      content: [{ type: "text", text: "legacy" }],
      processed_at: null,
    };
    const processed: WireEvent = { ...first, processed_at: PROCESSED_AT };

    const result = upsertSessionEvent([first], processed);

    expect(result.action).toBe("update");
    expect(result.events).toEqual([processed]);
  });
});
