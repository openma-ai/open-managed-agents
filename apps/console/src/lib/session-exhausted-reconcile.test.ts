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
  it("retains still-present null processed_at after exhausted (no delete)", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: ["sevt_a", "sevt_b"],
      listedEvents: [
        {
          id: "sevt_a",
          type: "user.message",
          processed_at: null,
          content: [{ type: "text", text: "advances with next round" }],
        },
        {
          id: "sevt_b",
          type: "user.message",
          processed_at: null,
        },
        {
          id: "sevt_idle",
          type: "session.status_idle",
          processed_at: "2026-10-31T22:00:00.000Z",
          stop_reason: { type: "retries_exhausted" },
        },
      ],
    });

    expect(result.retainedIds).toEqual(["sevt_a", "sevt_b"]);
    expect(result.anomalyRetainedIds).toEqual(["sevt_a", "sevt_b"]);
    expect(result.remainingPendingIds).toEqual(["sevt_a", "sevt_b"]);
    expect(result.flushedIds).toEqual([]);
    expect(result.processedIds).toEqual([]);
  });

  it("reports absent ids as vanished (unexpected under no-delete), retains present null", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: ["sevt_held", "sevt_gone"],
      listedEvents: [
        {
          id: "sevt_held",
          type: "user.message",
          processed_at: null,
          content: [{ type: "text", text: "expected retain after exhausted" }],
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
    expect(result.retainedIds).toEqual(["sevt_held"]);
    expect(result.remainingPendingIds).toEqual(["sevt_held"]);
    expect(result.processedIds).toEqual([]);
  });

  it("drops local pending when the same id is now stamped processed", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: ["sevt_ingested", "sevt_missing"],
      listedEvents: [
        {
          id: "sevt_ingested",
          type: "user.message",
          processed_at: "2026-10-31T22:01:00.000Z",
        },
      ],
    });

    expect(result.processedIds).toEqual(["sevt_ingested"]);
    expect(result.flushedIds).toEqual(["sevt_missing"]);
    expect(result.retainedIds).toEqual([]);
    expect(result.remainingPendingIds).toEqual([]);
  });

  it("treats absent processed_at the same as null for the retain path", () => {
    const result = reconcilePendingAfterExhaustedFlush({
      localPendingIds: ["sevt_nullish"],
      listedEvents: [{ id: "sevt_nullish", type: "user.message" }],
    });

    expect(result.retainedIds).toEqual(["sevt_nullish"]);
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
      retainedIds: [],
      processedIds: [],
      remainingPendingIds: [],
    });
  });
});
