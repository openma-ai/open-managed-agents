import { describe, expect, it } from "vitest";
import type {
  SessionExecutionFence,
  SessionExecutionStorePort,
} from "@open-managed-agents/session-runtime-contract";
import {
  isSessionExecutionClaimActive,
  isSessionExecutionFenceActive,
  type SessionExecutionLeases,
} from "../src/execution-lease";

/** One isolated fixture: the store that writes the execution rows and the
 * SessionExecutionLeases adapter under test that reads them back. */
export interface SessionExecutionLeasesFixture {
  workspaceId: string;
  executions: SessionExecutionStorePort;
  leases: SessionExecutionLeases;
}

export interface SessionExecutionLeasesTestHarness {
  withLeases<T>(fixtureId: string, run: (fixture: SessionExecutionLeasesFixture) => Promise<T>): Promise<T>;
}

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 8, 12, 0, seconds)).toISOString();
const clock = (seconds: number) => () => Date.parse(at(seconds));

async function admit(fixture: SessionExecutionLeasesFixture, id: string, sessionId = "session_01") {
  await fixture.executions.admit({
    execution: {
      id, workspaceId: fixture.workspaceId, sessionId, admittedAt: at(0),
      events: [{ id, type: "user.message", content: [{ type: "text", text: id }], processedAt: at(0) }],
    },
  });
}

async function claim(fixture: SessionExecutionLeasesFixture, attemptId: string, claimedAt: number, leaseTtlMs = 30_000): Promise<SessionExecutionFence> {
  const claimed = await fixture.executions.claim({
    workspaceId: fixture.workspaceId, sessionId: "session_01", ownerId: `owner_${attemptId}`, attemptId,
    claimedAt: at(claimedAt), leaseTtlMs,
  });
  if (claimed.type !== "claimed") throw new Error(`expected a claim for ${attemptId}`);
  return claimed.fence;
}

const claimOf = (fence: SessionExecutionFence, claimedAt: number) => ({
  workspaceId: fence.workspaceId, sessionId: fence.sessionId, executionId: fence.executionId,
  generation: fence.generation, claimedAt: at(claimedAt),
});

/** Behavior suite every SessionExecutionLeases adapter must pass (design §0.7
 * 测试门禁 2): the same execution rows must give the same fence verdicts. */
export function sessionExecutionLeasesConformance(adapterName: string, harness: SessionExecutionLeasesTestHarness): void {
  describe(`${adapterName} SessionExecutionLeases conformance`, () => {
    it("reads nothing for an unknown execution or another workspace", () =>
      harness.withLeases("missing", async (fixture) => {
        await admit(fixture, "execution_01");
        const fence = await claim(fixture, "attempt_1", 1);
        await expect(fixture.leases.find({ workspaceId: fixture.workspaceId, executionId: "execution_missing" })).resolves.toBeNull();
        await expect(fixture.leases.find({ workspaceId: `${fixture.workspaceId}_other`, executionId: "execution_01" })).resolves.toBeNull();
        await expect(isSessionExecutionFenceActive(fixture.leases, { ...fence, workspaceId: `${fixture.workspaceId}_other` }, clock(2))).resolves.toBe(false);
      }));

    it("reports a queued execution without a live attempt", () =>
      harness.withLeases("queued", async (fixture) => {
        await admit(fixture, "execution_01");
        await expect(fixture.leases.find({ workspaceId: fixture.workspaceId, executionId: "execution_01" })).resolves.toMatchObject({
          executionId: "execution_01", sessionId: "session_01", state: "queued",
          attemptId: null, ownerId: null, claimedAtMs: null, leaseExpiresAtMs: null,
        });
      }));

    it("reads the claimed attempt exactly and accepts its fence and claim", () =>
      harness.withLeases("claimed", async (fixture) => {
        await admit(fixture, "execution_01");
        const fence = await claim(fixture, "attempt_1", 1);
        await expect(fixture.leases.find({ workspaceId: fixture.workspaceId, executionId: "execution_01" })).resolves.toEqual({
          executionId: "execution_01", sessionId: "session_01", state: "running",
          attemptId: "attempt_1", ownerId: "owner_attempt_1", generation: 1,
          claimedAtMs: Date.parse(at(1)), leaseExpiresAtMs: Date.parse(at(31)),
        });
        await expect(isSessionExecutionFenceActive(fixture.leases, fence, clock(2))).resolves.toBe(true);
        await expect(isSessionExecutionClaimActive(fixture.leases, claimOf(fence, 1), clock(2))).resolves.toBe(true);
        await expect(isSessionExecutionFenceActive(fixture.leases, fence, clock(31))).resolves.toBe(false);
      }));

    it("follows a heartbeat renewal past the fence snapshot's own expiry", () =>
      harness.withLeases("renewed", async (fixture) => {
        await admit(fixture, "execution_01");
        const fence = await claim(fixture, "attempt_1", 1, 10_000);
        await expect(fixture.executions.renew({ fence, renewedAt: at(9), leaseTtlMs: 10_000 })).resolves.toMatchObject({ type: "renewed" });
        await expect(fixture.leases.find({ workspaceId: fixture.workspaceId, executionId: "execution_01" })).resolves.toMatchObject({
          leaseExpiresAtMs: Date.parse(at(19)), claimedAtMs: Date.parse(at(1)),
        });
        await expect(isSessionExecutionFenceActive(fixture.leases, fence, clock(15))).resolves.toBe(true);
        await expect(isSessionExecutionClaimActive(fixture.leases, claimOf(fence, 1), clock(15))).resolves.toBe(true);
      }));

    it("fences the stale attempt once a replacement reclaims the execution", () =>
      harness.withLeases("reclaimed", async (fixture) => {
        await admit(fixture, "execution_01");
        const stale = await claim(fixture, "attempt_1", 1, 1_000);
        const current = await claim(fixture, "attempt_2", 3);
        expect(current.generation).toBe(2);
        await expect(isSessionExecutionFenceActive(fixture.leases, stale, clock(4))).resolves.toBe(false);
        await expect(isSessionExecutionClaimActive(fixture.leases, claimOf(stale, 1), clock(4))).resolves.toBe(false);
        await expect(isSessionExecutionFenceActive(fixture.leases, current, clock(4))).resolves.toBe(true);
        await expect(isSessionExecutionClaimActive(fixture.leases, claimOf(current, 3), clock(4))).resolves.toBe(true);
      }));

    it("revokes the fence when the attempt settles or the Session is cancelled", () =>
      harness.withLeases("settled", async (fixture) => {
        await admit(fixture, "execution_01");
        const settled = await claim(fixture, "attempt_1", 1);
        await expect(fixture.executions.settle({ fence: settled, settledAt: at(2), outcome: "completed" })).resolves.toMatchObject({ type: "settled" });
        await expect(fixture.leases.find({ workspaceId: fixture.workspaceId, executionId: "execution_01" })).resolves.toMatchObject({ state: "completed" });
        await expect(isSessionExecutionFenceActive(fixture.leases, settled, clock(3))).resolves.toBe(false);
        await expect(isSessionExecutionClaimActive(fixture.leases, claimOf(settled, 1), clock(3))).resolves.toBe(false);

        await admit(fixture, "execution_02");
        const cancelled = await claim(fixture, "attempt_2", 4);
        await fixture.executions.cancelSession({ workspaceId: fixture.workspaceId, sessionId: "session_01", cancelledAt: at(5), reason: "session terminated" });
        await expect(fixture.leases.find({ workspaceId: fixture.workspaceId, executionId: "execution_02" })).resolves.toMatchObject({ state: "cancelled" });
        await expect(isSessionExecutionFenceActive(fixture.leases, cancelled, clock(6))).resolves.toBe(false);
      }));
  });
}
