import { describe, expect, it } from "vitest";
import { hasQueuedUserMessage, isQueuedSessionEvent } from "./session-event-queue";

describe("isQueuedSessionEvent", () => {
  it("treats turn.queued as queued", () => {
    expect(isQueuedSessionEvent({ type: "turn.queued" })).toBe(true);
  });

  it.each(["user.message", "user.interrupt", "user.tool_confirmation", "system.message"])(
    "treats %s with delivery queued as queued",
    (type) => {
      expect(isQueuedSessionEvent({ type, delivery: "queued" })).toBe(true);
      expect(isQueuedSessionEvent({ type, data: { delivery: "queued" } })).toBe(true);
    },
  );

  it.each(["user.message", "user.interrupt", "user.tool_confirmation", "system.message"])(
    "treats %s with delivery processed as processed",
    (type) => {
      expect(isQueuedSessionEvent({ type, delivery: "processed" })).toBe(false);
      expect(isQueuedSessionEvent({ type, data: { delivery: "processed" } })).toBe(false);
    },
  );

  it.each([
    "user.define_outcome",
    "user.custom_tool_result",
    "user.tool_result",
  ])("treats %s as processed on receipt even without delivery", (type) => {
    expect(isQueuedSessionEvent({ type, delivery: "queued" })).toBe(false);
    expect(isQueuedSessionEvent({ type })).toBe(false);
  });

  it("never queues agent, session, or span events", () => {
    expect(isQueuedSessionEvent({ type: "agent.message", delivery: "queued" })).toBe(false);
    expect(isQueuedSessionEvent({ type: "session.status_running" })).toBe(false);
    expect(isQueuedSessionEvent({ type: "span.model_request_start" })).toBe(false);
  });

  it("ignores CMA processed_at (GUI must not consult it)", () => {
    expect(isQueuedSessionEvent({ type: "user.message", processed_at: null })).toBe(false);
    expect(isQueuedSessionEvent({ type: "user.message", processed_at: "2026-10-31T12:00:00.000Z" })).toBe(false);
  });
});

describe("hasQueuedUserMessage", () => {
  it("detects a queued trigger inside canonical turn rawEvents", () => {
    expect(
      hasQueuedUserMessage([
        { type: "turn.queued" },
        { type: "agent.message", delivery: "processed" },
      ]),
    ).toBe(true);
    expect(
      hasQueuedUserMessage([
        { type: "user.message", delivery: "queued" },
        { type: "agent.message" },
      ]),
    ).toBe(true);
    expect(
      hasQueuedUserMessage([
        { type: "user.message", delivery: "processed" },
        { type: "agent.message" },
      ]),
    ).toBe(false);
  });

  it("does not mark a running turn queued because a non-message user event is queued", () => {
    expect(
      hasQueuedUserMessage([
        { type: "user.message", delivery: "processed" },
        { type: "user.tool_confirmation", delivery: "queued" },
      ]),
    ).toBe(false);
  });
});
