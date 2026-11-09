import { expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "../../sql-client/src/index";
import { SqlSessionExecutionStore, ensureSessionExecutionCoordinatorSchema } from "../src/coordination";
import {
  decideExpiredExecution,
  decideRecoveryFromCanonicalStream,
  type CoordinationAction,
  type ExecutionLeaseRecord,
} from "../../session-runtime/src/coordination-policy";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, seconds)).toISOString();

async function setup() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureSessionExecutionCoordinatorSchema(sql);
  const a = new SqlSessionExecutionStore(sql, {
    recoveryScope: { workspaceId: "w", sessionId: "session_a" },
  });
  const b = new SqlSessionExecutionStore(sql, {
    recoveryScope: { workspaceId: "w", sessionId: "session_b" },
  });
  for (const [id, sessionId] of [["A", "session_a"], ["B", "session_b"]]) {
    await a.admit({
      execution: {
        id, workspaceId: "w", sessionId, admittedAt: at(1),
        events: [{ id, type: "user.message", content: [{ type: "text", text: id }], processedAt: at(1) }],
      },
      policy: { maxAttempts: 3, timeoutMs: 60_000 },
    });
  }
  await a.claim({
    workspaceId: "w", sessionId: "session_a", ownerId: "dead_a",
    attemptId: "attempt_a", claimedAt: at(2), leaseTtlMs: 1_000,
  });
  return { a, b, sql };
}

function evidenceDecision(record: ExecutionLeaseRecord): CoordinationAction | null {
  const decision = decideRecoveryFromCanonicalStream({
    inputAtMs: record.admittedAtMs ?? 0,
    eventsAfterInput: [{ type: "agent.tool_use" }],
    unpairedToolUseCount: 1,
    completedOutputCount: 0,
    providerDispatches: record.attemptCount,
  });
  return decision.type === "requeue"
    ? decideExpiredExecution(record, Date.parse(at(5)))
    : {
        type: "finalize-interrupted", executionId: record.executionId, laneId: record.laneId,
        reason: decision.reason,
        attemptCount: record.attemptCount, maxAttempts: record.maxAttempts,
      };
}

it("canonical recovery requeues with unknown tool outcome preserved", async () => {
  const { a } = await setup();
  await a.sweepExpired(Date.parse(at(5)), { decideForRecord: evidenceDecision });
  expect(await a.find({ workspaceId: "w", executionId: "A" })).toMatchObject({ state: "queued" });
});

it("a recoverable lost owner stays active rather than becoming a terminal failure", async () => {
  const { a } = await setup();
  const scope = { workspaceId: "w", sessionId: "session_a" };
  expect(await a.latestSettled(scope)).toBeNull();
  await a.sweepExpired(Date.parse(at(5)), { decideForRecord: evidenceDecision });
  expect(await a.listActive(scope)).toMatchObject([{ id: "A", state: "queued" }]);
  expect(await a.latestSettled(scope)).toBeNull();
  expect(await a.latestSettled({ workspaceId: "w", sessionId: "session_b" })).toBeNull();
});

it("another session's claim and renew cannot bypass canonical recovery", async () => {
  const { a, b } = await setup();
  const claimed = await b.claim({
    workspaceId: "w", sessionId: "session_b", ownerId: "owner_b",
    attemptId: "attempt_b", claimedAt: at(5), leaseTtlMs: 30_000,
  });
  expect(claimed.type).toBe("claimed");
  if (claimed.type !== "claimed") throw new Error("B was not claimed");
  await b.renew({ fence: claimed.fence, renewedAt: at(6), leaseTtlMs: 30_000 });
  expect(await a.find({ workspaceId: "w", executionId: "A" })).toMatchObject({ state: "running" });
  let calls = 0;
  await a.sweepExpired(Date.parse(at(6)), {
    decideForRecord(record) { calls++; return evidenceDecision(record); },
  });
  expect(calls).toBe(1);
  expect(await a.find({ workspaceId: "w", executionId: "A" })).toMatchObject({ state: "queued" });
});

it("scoped claim cannot take over its own expired execution without recovery", async () => {
  const { a } = await setup();
  expect(await a.claim({
    workspaceId: "w", sessionId: "session_a", ownerId: "replacement",
    attemptId: "new", claimedAt: at(5), leaseTtlMs: 1_000,
  })).toEqual({ type: "empty" });
});

it("an explicit recovery sweep only consults evidence from its own session", async () => {
  const { a, b } = await setup();
  await b.claim({
    workspaceId: "w", sessionId: "session_b", ownerId: "dead_b",
    attemptId: "attempt_b", claimedAt: at(2), leaseTtlMs: 1_000,
  });
  const seen: string[] = [];
  await a.sweepExpired(Date.parse(at(5)), {
    decideForRecord(record) { seen.push(record.executionId); return evidenceDecision(record); },
  });
  expect(seen).toEqual(["A"]);
  expect(await b.find({ workspaceId: "w", executionId: "B" })).toMatchObject({ state: "running" });
});

it("explicit recovery can still requeue a provably unapplied input", async () => {
  const { a } = await setup();
  await a.sweepExpired(Date.parse(at(5)), {
    decideForRecord: record => decideExpiredExecution(record, Date.parse(at(5))),
  });
  expect(await a.find({ workspaceId: "w", executionId: "A" })).toMatchObject({ state: "queued" });
  expect((await a.claim({
    workspaceId: "w", sessionId: "session_a", ownerId: "replacement",
    attemptId: "new", claimedAt: at(6), leaseTtlMs: 1_000,
  })).type).toBe("claimed");
});

// Full eviction boundary: the old owner cannot renew, canonical tool evidence
// forbids replay, and the same SQL row feeds the public finalizer.
it("an evicted recoverable turn closes its tool result without terminal events", async () => {
  const { a } = await setup();
  const { finalizeStaleTurns } = await import("../../session-runtime/src/finalize-stale-turns");
  await a.sweepExpired(Date.parse(at(5)), { decideForRecord: evidenceDecision });
  const events: Array<Record<string, unknown>> = [];
  let status = { type: "session.status_running", ts: Date.parse(at(2)) / 1000 };
  await finalizeStaleTurns({
    unknownToolResultText: "interrupted", instanceStartedAt: Date.parse(at(6)), now: () => Date.parse(at(10)),
    listToolUses: () => [{ id: "tool", type: "agent.tool_use" }], listToolResultIds: () => [], parkedCallIds: () => [],
    append: async event => { events.push(event as unknown as Record<string, unknown>); if (event.type === "session.status_idle") status = { type: event.type, ts: Date.parse(at(10)) / 1000 }; },
    hasEvent: id => events.some(event => event.id === id), broadcast: () => {}, listOrphanTurns: async () => [], endTurn: async () => {},
    isTurnActive: () => false, hasLiveWork: () => false, latestSessionStatus: () => status,
    clearMarkerlessTurn: async () => false,
    executions: async () => ({ store: a, workspaceId: "w", sessionId: "session_a" }),
    scheduleGraceRetry: async () => {}, log: () => {},
  });
  expect(events.map(e => e.type)).toEqual(["agent.tool_result"]);
  expect(status.type).toBe("session.status_running");
  expect(await a.listActive({ workspaceId: "w", sessionId: "session_a" })).toMatchObject([{ id: "A", state: "queued" }]);
});
