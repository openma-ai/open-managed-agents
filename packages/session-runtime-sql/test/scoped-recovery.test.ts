import { expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "../../sql-client/src/index";
import { SqlSessionExecutionStore, ensureSessionExecutionCoordinatorSchema } from "../src/coordination";
import {
  decideExpiredExecution,
  decideRecoveryFromCanonicalStream,
  type CoordinationAction,
  type ExecutionLeaseRecord,
} from "../../session-runtime-contract/src/coordination";

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
        reason: decision.type === "reuse" ? "input_applied" : decision.reason,
        attemptCount: record.attemptCount, maxAttempts: record.maxAttempts,
      };
}

it("canonical recovery interrupts a tool whose outcome is unknown", async () => {
  const { a } = await setup();
  await a.sweepExpired(Date.parse(at(5)), { decideForRecord: evidenceDecision });
  expect(await a.find({ workspaceId: "w", executionId: "A" })).toMatchObject({ state: "failed" });
});

it("after the sweep interrupts a dead owner, the Session's latest settled execution carries the failure", async () => {
  const { a } = await setup();
  const scope = { workspaceId: "w", sessionId: "session_a" };
  expect(await a.latestSettled(scope)).toBeNull();
  await a.sweepExpired(Date.parse(at(5)), { decideForRecord: evidenceDecision });
  expect(await a.listActive(scope)).toEqual([]);
  expect(await a.latestSettled(scope)).toMatchObject({
    id: "A", state: "failed", settledAt: at(5), failure: "execution interrupted on unpaired tool call",
  });
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
  expect(await a.find({ workspaceId: "w", executionId: "A" })).toMatchObject({ state: "failed" });
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
