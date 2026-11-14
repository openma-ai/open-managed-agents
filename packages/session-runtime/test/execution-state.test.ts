import { expect, it } from "vitest";
import { transitionExecution } from "../src/execution-state";

it("keeps live attempts, requeues stopped lost attempts, and cancels an interrupt in the reclaim window", () => {
  const running = { state: "running", revision: 2, attemptId: "a", attemptCount: 1, maxAttempts: 3, leaseExpiresAtMs: 100, deadlineAtMs: null, interruptRequested: false } as const;
  expect(transitionExecution(running, { type: "lease_lost", nowMs: 101, liveAttemptIds: ["a"] })).toBeNull();
  expect(transitionExecution(running, { type: "lease_lost", nowMs: 101, liveAttemptIds: [] })).toMatchObject({ expectedRevision: 2, next: { state: "queued", revision: 3, reason: "lease_lost" } });
  expect(transitionExecution({ ...running, interruptRequested: true }, { type: "lease_lost", nowMs: 101, liveAttemptIds: [] })).toMatchObject({ next: { state: "cancelled", reason: "user_cancelled" } });
});

it("never leaves an expired no-deadline execution running beyond max_attempts", () => {
  expect(transitionExecution({ state: "running", revision: 9, attemptId: "a", attemptCount: 3, maxAttempts: 3, leaseExpiresAtMs: 100, deadlineAtMs: null, interruptRequested: false },
    { type: "lease_lost", nowMs: 101, liveAttemptIds: [] })).toMatchObject({ next: { state: "failed", reason: "retries_exhausted", revision: 10 } });
});
