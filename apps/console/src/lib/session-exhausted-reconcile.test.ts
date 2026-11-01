import { describe, expect, it } from "vitest";
import {
  isExhaustedSettleEvent,
  reconcilePendingAfterExhaustedFlush,
} from "./session-exhausted-reconcile";

describe("isExhaustedSettleEvent", () => {
  it("detects idle stop_reason retries_exhausted", () => {
    expect(
      isExhaustedSettleEvent({
        type: "session.status_idle",
        stop_reason: { type: "retries_exhausted" },
      }),
    ).toBe(true);
  });

  it("detects session.error retry_status exhausted", () => {
    expect(
      isExhaustedSettleEvent({
        type: "session.error",
        error: { retry_status: { type: "exhausted" } },
      }),
    ).toBe(true);
  });

  it("ignores ordinary idle and non-exhausted errors", () => {
    expect(
      isExhaustedSettleEvent({
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      }),
    ).toBe(false);
    expect(
      isExhaustedSettleEvent({
        type: "session.error",
        error: { retry_status: { type: "retrying" } },
      }),
    ).toBe(false);
    expect(isExhaustedSettleEvent({ type: "user.message" })).toBe(false);
  });
});

describe("reconcilePendingAfterExhaustedFlush", () => {
  it("clears local pending when list ids vanished after exhausted (flush=delete)", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: ["sevt_a", "sevt_b"],
      listedEvents: [
        {
          id: "sevt_idle",
          type: "session.status_idle",
          processed_at: "2026-10-31T22:00:00.000Z",
          stop_reason: { type: "retries_exhausted" },
        },
        // sevt_a / sevt_b absent → flushed
      ],
    });

    expect(result.flushedIds).toEqual(["sevt_a", "sevt_b"]);
    expect(result.anomalyRetainedIds).toEqual([]);
    expect(result.processedIds).toEqual([]);
    expect(result.remainingPendingIds).toEqual([]);
  });

  it("keeps still-present null processed_at as anomaly (not a hold queue)", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: ["sevt_held_looking", "sevt_gone"],
      listedEvents: [
        {
          id: "sevt_held_looking",
          type: "user.message",
          processed_at: null,
          content: [{ type: "text", text: "should not remain under delete-flush" }],
        },
        {
          id: "sevt_idle",
          type: "session.status_idle",
          processed_at: "2026-10-31T22:05:00.000Z",
          stop_reason: { type: "retries_exhausted" },
        },
      ],
    });

    expect(result.flushedIds).toEqual(["sevt_gone"]);
    expect(result.anomalyRetainedIds).toEqual(["sevt_held_looking"]);
    expect(result.remainingPendingIds).toEqual(["sevt_held_looking"]);
    expect(result.processedIds).toEqual([]);
  });

  it("drops local pending when the same id is now stamped processed", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: ["sevt_ingested", "sevt_flushed"],
      listedEvents: [
        {
          id: "sevt_ingested",
          type: "user.message",
          processed_at: "2026-10-31T22:01:00.000Z",
        },
      ],
    });

    expect(result.processedIds).toEqual(["sevt_ingested"]);
    expect(result.flushedIds).toEqual(["sevt_flushed"]);
    expect(result.anomalyRetainedIds).toEqual([]);
    expect(result.remainingPendingIds).toEqual([]);
  });

  it("treats absent processed_at the same as null for the anomaly path", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: ["sevt_nullish"],
      listedEvents: [{ id: "sevt_nullish", type: "user.message" }],
    });

    expect(result.anomalyRetainedIds).toEqual(["sevt_nullish"]);
    expect(result.remainingPendingIds).toEqual(["sevt_nullish"]);
  });

  it("is a no-op when there is no local pending", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: [],
      listedEvents: [{ id: "sevt_x", type: "user.message", processed_at: null }],
    });

    expect(result).toEqual({
      flushedIds: [],
      anomalyRetainedIds: [],
      processedIds: [],
      remainingPendingIds: [],
    });
  });
});
