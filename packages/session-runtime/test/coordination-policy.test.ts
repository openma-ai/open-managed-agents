import { describe, expect, it } from "vitest";
import {
  decideClaim,
  decideExpiredExecution,
  decideLeaseRenewal,
  evaluateCoordinationPolicy,
  type ExecutionLeaseRecord,
} from "@open-managed-agents/session-runtime-contract/coordination";

const NOW = Date.UTC(2026, 8, 4, 0, 0, 30);

function execution(
  overrides: Partial<ExecutionLeaseRecord> = {},
): ExecutionLeaseRecord {
  return {
    executionId: "exec_1",
    laneId: "sthr_primary",
    state: "running",
    attemptCount: 1,
    maxAttempts: 3,
    leaseExpiresAtMs: NOW + 90_000,
    deadlineAtMs: NOW + 3_600_000,
    ...overrides,
  };
}

describe("shared coordination lease policy", () => {
  it("is quiescent only when there is no lease, queue, or schedule", () => {
    const result = evaluateCoordinationPolicy({ nowMs: NOW });
    expect(result.actions).toEqual([]);
    expect(result.nextWakeAtMs).toBeNull();
    expect(result.quiescent).toBe(true);
  });

  it("wakes before a valid lease expires and emits renew inside the horizon", () => {
    const early = evaluateCoordinationPolicy({
      nowMs: NOW,
      executions: [execution()],
      heartbeatIntervalMs: 30_000,
    });
    expect(early.actions).toEqual([]);
    expect(early.nextWakeAtMs).toBe(NOW + 30_000);
    expect(early.quiescent).toBe(false);

    const due = evaluateCoordinationPolicy({
      nowMs: NOW + 60_000,
      executions: [execution()],
      heartbeatIntervalMs: 30_000,
    });
    expect(due.actions).toEqual([
      {
        type: "renew",
        executionId: "exec_1",
        laneId: "sthr_primary",
        reason: "lease_renewal_due",
        renewAtMs: NOW + 60_000,
        leaseExpiresAtMs: NOW + 90_000,
      },
    ]);
    expect(due.nextWakeAtMs).toBe(NOW + 90_000);
  });

  it("requeues an expired lease while attempt budget remains", () => {
    const expired = execution({
      leaseExpiresAtMs: NOW - 1,
      attemptCount: 1,
      maxAttempts: 3,
    });
    expect(decideExpiredExecution(expired, NOW)).toEqual({
      type: "requeue",
      executionId: "exec_1",
      laneId: "sthr_primary",
      reason: "lease_expired",
      attemptCount: 1,
      maxAttempts: 3,
    });
    const result = evaluateCoordinationPolicy({
      nowMs: NOW,
      executions: [expired],
      queuedWakeDelayMs: 5,
    });
    expect(result.actions[0]).toMatchObject({ type: "requeue" });
    expect(result.nextWakeAtMs).toBe(NOW + 5);
    expect(result.quiescent).toBe(false);
  });

  it("finalizes an expired lease once attempts are exhausted", () => {
    const exhausted = execution({
      leaseExpiresAtMs: NOW,
      attemptCount: 3,
      maxAttempts: 3,
    });
    expect(decideExpiredExecution(exhausted, NOW)).toEqual({
      type: "finalize-interrupted",
      executionId: "exec_1",
      laneId: "sthr_primary",
      reason: "lease_expired_attempts_exhausted",
      attemptCount: 3,
      maxAttempts: 3,
    });
    const result = evaluateCoordinationPolicy({
      nowMs: NOW,
      executions: [exhausted],
    });
    expect(result.actions).toHaveLength(1);
    // Finalization needs no follow-up wake of its own.
    expect(result.nextWakeAtMs).toBeNull();
  });

  it("deadline wins over a live lease and finalizes queued work too", () => {
    const missed = execution({ deadlineAtMs: NOW });
    expect(decideExpiredExecution(missed, NOW)).toMatchObject({
      type: "finalize-interrupted",
      reason: "deadline_exceeded",
    });
    expect(decideExpiredExecution(
      execution({ state: "queued", deadlineAtMs: NOW, leaseExpiresAtMs: null }),
      NOW,
    )).toMatchObject({
      type: "finalize-interrupted",
      reason: "deadline_exceeded",
    });
    expect(decideExpiredExecution(execution(), NOW)).toBeNull();
  });

  it("claims queued work, drains local inputs, and ignores held rows", () => {
    const result = evaluateCoordinationPolicy({
      nowMs: NOW,
      executions: [
        execution({
          executionId: "queued_1",
          state: "queued",
          attemptCount: 0,
          leaseExpiresAtMs: null,
        }),
        execution({
          executionId: "held_1",
          state: "queued",
          attemptCount: 0,
          leaseExpiresAtMs: null,
          heldAfterExhausted: true,
        }),
      ],
      queuedInputs: [{ id: "evt_1", laneId: "sthr_primary" }],
    });
    expect(result.actions).toEqual([
      {
        type: "claim",
        executionId: "queued_1",
        laneId: "sthr_primary",
        reason: "queued_execution",
      },
      {
        type: "drain",
        laneId: "sthr_primary",
        reason: "queued_input",
      },
    ]);
    expect(result.nextWakeAtMs).toBe(NOW + 1);
  });

  it("held-only queued work is quiescent", () => {
    const result = evaluateCoordinationPolicy({
      nowMs: NOW,
      executions: [execution({
        state: "queued",
        attemptCount: 1,
        leaseExpiresAtMs: null,
        heldAfterExhausted: true,
      })],
    });
    expect(result.actions).toEqual([]);
    expect(result.nextWakeAtMs).toBeNull();
    expect(result.quiescent).toBe(true);
  });

  it("keeps active in-memory turns and schedules as wake inputs", () => {
    expect(evaluateCoordinationPolicy({
      nowMs: NOW,
      activeTurns: [{ id: "turn_1" }],
      heartbeatIntervalMs: 30_000,
    }).nextWakeAtMs).toBe(NOW + 30_000);

    expect(evaluateCoordinationPolicy({
      nowMs: NOW,
      schedules: [{ id: "sched", dueAtMs: NOW + 12_345 }],
    }).nextWakeAtMs).toBe(NOW + 12_345);
  });

  it("renewal and claim helpers enforce lease, budget, and deadline", () => {
    expect(decideLeaseRenewal(execution(), NOW, { leaseTtlMs: 60_000 }))
      .toEqual({ type: "renew", leaseExpiresAtMs: NOW + 60_000 });
    // Deadline clamps the extension.
    expect(decideLeaseRenewal(
      execution({ deadlineAtMs: NOW + 10_000 }),
      NOW,
      { leaseTtlMs: 60_000 },
    )).toEqual({ type: "renew", leaseExpiresAtMs: NOW + 10_000 });
    expect(decideLeaseRenewal(
      execution({ leaseExpiresAtMs: NOW }),
      NOW,
      { leaseTtlMs: 60_000 },
    )).toBeNull();

    expect(decideClaim(execution({ state: "queued", attemptCount: 0 }), NOW))
      .toEqual({ claim: true, reason: "queued" });
    expect(decideClaim(execution(), NOW))
      .toEqual({ claim: false, reason: "lease_active" });
    expect(decideClaim(execution({ leaseExpiresAtMs: NOW }), NOW))
      .toEqual({ claim: true, reason: "expired_lease_takeover" });
    expect(decideClaim(execution({ attemptCount: 3, maxAttempts: 3 }), NOW))
      .toEqual({ claim: false, reason: "attempts_exhausted" });
  });
});
