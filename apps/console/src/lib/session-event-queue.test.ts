import { describe, expect, it } from "vitest";
import { hasQueuedUserMessage, isQueuedSessionEvent } from "./session-event-queue";

const PROCESSED_AT = "2026-10-31T12:00:00.000Z";

describe("isQueuedSessionEvent", () => {
  it.each(["user.message", "user.interrupt", "user.tool_confirmation", "system.message"])(
    "treats %s with null/undefined processed_at as queued",
    (type) => {
      expect(isQueuedSessionEvent({ type, processed_at: null })).toBe(true);
      expect(isQueuedSessionEvent({ type })).toBe(true);
    },
  );

  it.each(["user.message", "user.interrupt", "user.tool_confirmation", "system.message"])(
    "treats %s with processed_at set as processed",
    (type) => {
      expect(isQueuedSessionEvent({ type, processed_at: PROCESSED_AT })).toBe(false);
    },
  );

  it.each([
    "user.define_outcome",
    "user.custom_tool_result",
    "user.tool_result",
  ])("treats %s as processed on receipt even without processed_at", (type) => {
    expect(isQueuedSessionEvent({ type, processed_at: null })).toBe(false);
    expect(isQueuedSessionEvent({ type })).toBe(false);
  });

  it("never queues agent, session, or span events", () => {
    expect(isQueuedSessionEvent({ type: "agent.message", processed_at: null })).toBe(false);
    expect(isQueuedSessionEvent({ type: "session.status_running", processed_at: null })).toBe(false);
    expect(isQueuedSessionEvent({ type: "span.model_request_start" })).toBe(false);
  });

  it("ignores the OpenMA-only processed_at_ms field", () => {
    expect(
      isQueuedSessionEvent({ type: "user.message", processed_at_ms: Date.parse(PROCESSED_AT) }),
    ).toBe(true);
  });

  it("supports legacy transport payloads that nest processed_at under data", () => {
    expect(isQueuedSessionEvent({ type: "user.message", data: { processed_at: null } })).toBe(true);
    expect(
      isQueuedSessionEvent({ type: "user.message", data: { processed_at: PROCESSED_AT } }),
    ).toBe(false);
  });
});

describe("hasQueuedUserMessage", () => {
  it("detects a queued trigger inside canonical turn rawEvents", () => {
    expect(
      hasQueuedUserMessage([
        { type: "user.message", processed_at: null },
        { type: "agent.message", processed_at: PROCESSED_AT },
      ]),
    ).toBe(true);
    expect(
      hasQueuedUserMessage([
        { type: "user.message", processed_at: PROCESSED_AT },
        { type: "agent.message", processed_at: PROCESSED_AT },
      ]),
    ).toBe(false);
  });

  it("does not mark a running turn queued because a non-message user event is queued", () => {
    expect(
      hasQueuedUserMessage([
        { type: "user.message", processed_at: PROCESSED_AT },
        { type: "user.tool_confirmation", processed_at: null },
      ]),
    ).toBe(false);
  });
});
