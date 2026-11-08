import { describe, expect, it } from "vitest";
import {
  isSessionExecutionClaimActive, isSessionExecutionFenceActive, sessionExecutionLeasesFrom,
  type SessionExecutionLease, type SessionExecutionLeases,
} from "../src/execution-lease";

const NOW = Date.UTC(2026, 10, 8, 12);
const row: SessionExecutionLease = {
  executionId: "exe_1", sessionId: "sess", state: "running", attemptId: "att_1", ownerId: "owner",
  generation: 3, claimedAtMs: NOW - 60_000, leaseExpiresAtMs: NOW + 30_000,
};
const leases = (current: SessionExecutionLease | null): SessionExecutionLeases & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return { seen, async find(input) { seen.push(input); return current; } };
};
// The fence snapshot's own expiry has passed; only the row's (heartbeat-renewed) lease counts.
const fence = { executionId: "exe_1", workspaceId: "ws", sessionId: "sess", attemptId: "att_1", ownerId: "owner", generation: 3, expiresAt: new Date(NOW - 1).toISOString() };

describe("isSessionExecutionFenceActive (design §0.0 rule 10)", () => {
  it("accepts only the current attempt of a running execution and ignores the fence's own expiry", async () => {
    const current = leases(row);
    expect(await isSessionExecutionFenceActive(current, fence, () => NOW)).toBe(true);
    expect(current.seen).toEqual([{ workspaceId: "ws", executionId: "exe_1" }]);
    for (const stale of [{ attemptId: "att_0" }, { ownerId: "other" }, { generation: 2 }, { sessionId: "other" }]) {
      expect(await isSessionExecutionFenceActive(current, { ...fence, ...stale }, () => NOW)).toBe(false);
    }
  });

  it("rejects settled, expired and missing executions and malformed fences", async () => {
    for (const current of [{ ...row, state: "completed" }, { ...row, leaseExpiresAtMs: NOW }, { ...row, leaseExpiresAtMs: Number.NaN }, null]) {
      expect(await isSessionExecutionFenceActive(leases(current), fence, () => NOW)).toBe(false);
    }
    for (const bad of [{ generation: 0 }, { attemptId: "" }, { ownerId: "" }, { workspaceId: "" }]) {
      expect(await isSessionExecutionFenceActive(leases(row), { ...fence, ...bad }, () => NOW)).toBe(false);
    }
  });

  it("checks a credential claim by execution, generation and claim time", async () => {
    const claim = { workspaceId: "ws", sessionId: "sess", executionId: "exe_1", generation: 3, claimedAt: new Date(NOW - 60_000).toISOString() };
    expect(await isSessionExecutionClaimActive(leases(row), claim, () => NOW)).toBe(true);
    expect(await isSessionExecutionClaimActive(leases(row), { ...claim, claimedAt: new Date(NOW).toISOString() }, () => NOW)).toBe(false);
    expect(await isSessionExecutionClaimActive(leases(row), { ...claim, generation: 4 }, () => NOW)).toBe(false);
    expect(await isSessionExecutionClaimActive(leases(row), { ...claim, claimedAt: "invalid" }, () => NOW)).toBe(false);
  });

  it("reads a coordinator's SessionExecution as the same lease", async () => {
    const execution = { id: "exe_1", sessionId: "sess", state: "running", attempt: { id: "att_1", ownerId: "owner", generation: 3, claimedAt: new Date(NOW - 60_000).toISOString(), leaseExpiresAt: new Date(NOW + 30_000).toISOString() } };
    const fromCoordinator = sessionExecutionLeasesFrom(async () => execution as never);
    expect(await fromCoordinator.find({ workspaceId: "ws", executionId: "exe_1" })).toEqual(row);
    expect(await isSessionExecutionFenceActive(fromCoordinator, fence, () => NOW)).toBe(true);
    expect(await sessionExecutionLeasesFrom(async () => null).find({ workspaceId: "ws", executionId: "x" })).toBeNull();
  });
});
