import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdmitSessionExecution,
  SessionExecutionCoordinatorPort,
  SessionExecutionFence,
} from "@open-managed-agents/session-runtime-contract/coordination";
import {
  createBetterSqlite3SqlClient,
  Deadlock,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionCoordinator,
} from "../src/coordination";
import {
  sessionExecutionEventBatches,
  sessionExecutionId,
} from "@open-managed-agents/session-runtime-contract/coordination";
import { sessionExecutionStoreConformance } from
  "../../session-runtime-contract/test/execution-store-conformance";

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 4, 0, 0, seconds)).toISOString();

function executionRow(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: "workspace_01",
    session_id: "session_01",
    lane_id: "sthr_primary",
    id: "execution_row",
    admitted_at_ms: String(Date.parse(at(1))),
    events_json: JSON.stringify(admitted("event", "session_01", at(1)).execution.events),
    events_fingerprint: "fingerprint",
    state: "queued",
    attempt_id: null,
    owner_id: null,
    generation: "0",
    attempt_count: "0",
    max_attempts: "10",
    deadline_at_ms: String(Date.parse(at(30))),
    claimed_at_ms: null,
    lease_expires_at_ms: null,
    interrupt_requested_at_ms: null,
    settled_at_ms: null,
    failure: null,
    revision: "1",
    ...overrides,
  };
}

function fakeSql(options: {
  row?: Record<string, unknown> | null;
  allResults?: Array<{ name?: string }>;
  omitAllResults?: boolean;
  batchResults?: Array<{ meta: { changes: number } }>;
} = {}): SqlClient {
  const statement = {
    bind: () => statement,
    run: async () => ({ meta: { changes: 1 } }),
    first: async () => options.row ?? null,
    all: async () => options.omitAllResults
      ? {}
      : { results: options.allResults ?? [] },
  };
  return {
    prepare: () => statement,
    batch: async () => options.batchResults ?? [
      { meta: { changes: 0 } },
      { meta: { changes: 0 } },
    ],
    exec: async () => {},
  } as SqlClient;
}

function admitted(
  id: string,
  sessionId: string,
  admittedAt: string,
  text = id,
): AdmitSessionExecution {
  return {
    execution: {
      id,
      workspaceId: "workspace_01",
      sessionId,
      admittedAt,
      events: [{
        id,
        type: "user.message",
        content: [{ type: "text", text }],
        processedAt: admittedAt,
      }],
    },
  };
}

describe("SqlSessionExecutionCoordinator", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  let sql: SqlClient;
  let coordinator: SessionExecutionCoordinatorPort;

  beforeEach(async () => {
    sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSessionExecutionCoordinatorSchema(sql);
    coordinator = new SqlSessionExecutionCoordinator(sql);
  });

  it("continuationsOnly lets a tool answer pass a queued user.message and never claims the message", async () => {
    await coordinator.admit(admitted("queued_msg", "session_01", at(1)));
    await coordinator.admit({ execution: {
      id: "tool_answer", workspaceId: "workspace_01", sessionId: "session_01", admittedAt: at(2),
      events: [{ id: "tool_answer", type: "user.custom_tool_result", customToolUseId: "call_1",
        content: [{ type: "text", text: "ok" }], processedAt: at(2) } as never],
    } });
    const parked = { ownerId: "do", claimedAt: at(3), leaseTtlMs: 10_000, continuationsOnly: true };
    const first = await coordinator.claim({ ...parked, attemptId: "a1" });
    expect(first.type === "claimed" && first.execution.id).toBe("tool_answer");
    if (first.type !== "claimed") throw new Error("expected claim");
    await coordinator.settle({ fence: first.fence, settledAt: at(4), outcome: "completed" });
    expect((await coordinator.claim({ ...parked, attemptId: "a2", claimedAt: at(5) })).type).toBe("empty");
    const normal = await coordinator.claim({ ownerId: "do", attemptId: "a3", claimedAt: at(6), leaseTtlMs: 10_000 });
    expect(normal.type === "claimed" && normal.execution.id).toBe("queued_msg");
  });

  it("claims a default-mode Session without preparing the optional checkpoint-only lock table", async () => {
    await sql.exec("DROP TABLE managed_session_claim_locks");
    await coordinator.admit(admitted("no-lock", "session_01", at(1)));
    const result = await coordinator.claim({ ownerId: "ordinary_node", attemptId: "ordinary_attempt",
      claimedAt: at(2), leaseTtlMs: 10_000 });
    expect(result.type).toBe("claimed");
  });

  it("leaves a queued execution in place when the serial claim transaction deadlocks", async () => {
    let attempts = 0;
    const retryingSql: SqlClient = {
      prepare: (statement) => sql.prepare(statement),
      exec: (statement) => sql.exec(statement),
      batch: async () => {
        attempts++;
        throw new Deadlock({ op: "session_execution.claim", sessionId: "session_01" });
      },
    };
    const retrying = new SqlSessionExecutionCoordinator(retryingSql, { serializeSessionClaims: true });
    await retrying.admit(admitted("deadlock", "session_01", at(1)));
    await expect(retrying.claim({
      ownerId: "recovered",
      attemptId: "recovered_attempt",
      claimedAt: at(2),
      leaseTtlMs: 10_000,
    })).rejects.toBeInstanceOf(Deadlock);
    expect(attempts).toBe(1);
    await expect(retrying.find({
      workspaceId: "workspace_01",
      executionId: "deadlock",
    })).resolves.toMatchObject({ state: "queued" });
  });

  it("adds claim-lock version columns onto an older mutex table", async () => {
    await sql.exec("DROP TABLE managed_session_claim_locks");
    await sql.exec(`CREATE TABLE managed_session_claim_locks (
      workspace_id VARCHAR(191) NOT NULL,
      session_id VARCHAR(191) NOT NULL,
      claim_token VARCHAR(191) NOT NULL,
      PRIMARY KEY (workspace_id, session_id)
    )`);
    const { upgradeSessionClaimLockColumns } = await import("../src/coordination");
    await upgradeSessionClaimLockColumns(sql);
    const columns = await sql.prepare(
      "PRAGMA table_info(managed_session_claim_locks)",
    ).all<{ name: string }>();
    expect(columns.results?.map((column) => column.name)).toEqual(
      expect.arrayContaining(["version", "holder_execution_id", "claim_token"]),
    );
  });

  it("serializes opted-in cross-lane claims across owners without changing default lane concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "openma-serial-claims-"));
    roots.push(root);
    const dbPath = join(root, "shared.db");
    const firstSql = await createBetterSqlite3SqlClient(dbPath);
    const secondSql = await createBetterSqlite3SqlClient(dbPath);
    await ensureSessionExecutionCoordinatorSchema(firstSql);
    const first = new SqlSessionExecutionCoordinator(firstSql, { serializeSessionClaims: true });
    const second = new SqlSessionExecutionCoordinator(secondSql, { serializeSessionClaims: true });
    await first.admit({ ...admitted("primary", "session_01", at(1)), execution: {
      ...admitted("primary", "session_01", at(1)).execution, laneId: "sthr_primary",
    } });
    await first.admit({ ...admitted("child", "session_01", at(2)), execution: {
      ...admitted("child", "session_01", at(2)).execution, laneId: "sthr_child",
    } });
    const claims = await Promise.all([
      first.claim({ ownerId: "node_a", attemptId: "attempt_a", claimedAt: at(3), leaseTtlMs: 10_000 }),
      second.claim({ ownerId: "node_b", attemptId: "attempt_b", claimedAt: at(3), leaseTtlMs: 10_000 }),
    ]);
    expect(claims.filter((result) => result.type === "claimed")).toHaveLength(1);
    const owned = claims.find((result) => result.type === "claimed");
    if (owned?.type !== "claimed") throw new Error("missing first claim");
    expect(owned.execution.id).toBe("primary");
    expect(await second.claim({ ownerId: "node_b", attemptId: "attempt_c", claimedAt: at(4), leaseTtlMs: 10_000 }))
      .toEqual({ type: "empty" });
    await first.settle({ fence: owned.fence, settledAt: at(5), outcome: "completed" });
    const next = await second.claim({ ownerId: "node_b", attemptId: "attempt_d", claimedAt: at(6), leaseTtlMs: 10_000 });
    expect(next).toMatchObject({ type: "claimed", execution: { id: "child" } });
  });

  it("does not serialize two lanes of one Session unless explicitly opted in", async () => {
    await coordinator.admit(admitted("primary", "session_01", at(1)));
    await coordinator.admit({ ...admitted("child", "session_01", at(2)), execution: {
      ...admitted("child", "session_01", at(2)).execution, laneId: "sthr_child",
    } });
    const first = await coordinator.claim({ ownerId: "node_a", attemptId: "attempt_a", claimedAt: at(3), leaseTtlMs: 10_000 });
    const second = await coordinator.claim({ ownerId: "node_b", attemptId: "attempt_b", claimedAt: at(3), leaseTtlMs: 10_000 });
    expect([first, second].map((result) => result.type)).toEqual(["claimed", "claimed"]);
  });

  it("allows opted-in session claim takeover only after the previous lease expires", async () => {
    const first = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
    const second = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
    await first.admit(admitted("primary", "session_01", at(1)));
    await first.admit({ ...admitted("child", "session_01", at(2)), execution: {
      ...admitted("child", "session_01", at(2)).execution, laneId: "sthr_child",
    } });
    const initial = await first.claim({ ownerId: "node_a", attemptId: "attempt_a", claimedAt: at(3), leaseTtlMs: 2_000 });
    expect(initial.type).toBe("claimed");
    expect(await second.claim({ ownerId: "node_b", attemptId: "attempt_b", claimedAt: at(4), leaseTtlMs: 2_000 }))
      .toEqual({ type: "empty" });
    const takeover = await second.claim({ ownerId: "node_b", attemptId: "attempt_c", claimedAt: at(5), leaseTtlMs: 2_000 });
    expect(takeover).toMatchObject({ type: "claimed", execution: { id: "primary" }, fence: { generation: 2 } });
    if (initial.type !== "claimed") throw new Error("missing initial claim");
    expect(await first.settle({ fence: initial.fence, settledAt: at(6), outcome: "completed" }))
      .toEqual({ type: "lost" });
    expect(await first.claim({ ownerId: "node_a", attemptId: "attempt_d", claimedAt: at(6), leaseTtlMs: 2_000 }))
      .toEqual({ type: "empty" });
  });

  it("rejects malformed admissions, timestamps, leases, and empty execution ids", async () => {
    await expect(coordinator.admit({
      execution: {
        id: "empty",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        admittedAt: at(1),
        events: [],
      },
    })).rejects.toThrow("at least one event");
    await expect(coordinator.admit(
      admitted("bad_time", "session_01", "not-a-time"),
    )).rejects.toThrow("Invalid admission timestamp");
    await expect(coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a",
      claimedAt: at(1),
      leaseTtlMs: 0,
    })).rejects.toThrow("positive integer");
    await expect(coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_fractional",
      claimedAt: at(1),
      leaseTtlMs: 1.5,
    })).rejects.toThrow("positive integer");
    await expect(coordinator.admit({
      ...admitted("bad_attempts", "session_01", at(1)),
      policy: { maxAttempts: 0, timeoutMs: 1_000 },
    })).rejects.toThrow("maxAttempts must be a positive integer");
    await expect(coordinator.admit({
      ...admitted("fractional_attempts", "session_01", at(1)),
      policy: { maxAttempts: 1.5, timeoutMs: 1_000 },
    })).rejects.toThrow("maxAttempts must be a positive integer");
    await expect(coordinator.admit({
      ...admitted("bad_timeout", "session_01", at(1)),
      policy: { maxAttempts: 1, timeoutMs: 0 },
    })).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(coordinator.admit({
      ...admitted("fractional_timeout", "session_01", at(1)),
      policy: { maxAttempts: 1, timeoutMs: 1.5 },
    })).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(coordinator.admit({
      ...admitted(
        "overflow_deadline",
        "session_01",
        new Date(8_640_000_000_000_000).toISOString(),
      ),
      policy: { maxAttempts: 1, timeoutMs: Number.MAX_SAFE_INTEGER },
    })).rejects.toThrow("deadline exceeds safe timestamp range");
    expect(() => sessionExecutionId([])).toThrow("at least one event");
    expect(sessionExecutionId(admitted("one", "session_01", at(1)).execution.events))
      .toBe("one");
    const batches = sessionExecutionEventBatches([
      ...admitted("first", "session_01", at(1)).execution.events,
      ...admitted("second", "session_01", at(2)).execution.events,
    ]);
    expect(batches).toEqual([
      expect.objectContaining({ id: "first", laneId: "sthr_primary", events: expect.arrayContaining([
        expect.objectContaining({ id: "first" }),
        expect.objectContaining({ id: "second" }),
      ]) }),
    ]);
    expect(sessionExecutionEventBatches([{
      ...admitted("null_lane", "session_01", at(1)).execution.events[0],
      sessionThreadId: null,
    }])).toEqual([
      expect.objectContaining({ id: "null_lane", laneId: "sthr_primary" }),
    ]);
  });

  it("handles SQL portability envelopes and rejects corrupt execution rows", async () => {
    await expect(ensureSessionExecutionCoordinatorSchema(fakeSql({
      omitAllResults: true,
    }))).resolves.toBeUndefined();

    const portable = new SqlSessionExecutionCoordinator(fakeSql({
      row: executionRow(),
    }));
    await expect(portable.find({
      workspaceId: "workspace_01",
      executionId: "execution_row",
    })).resolves.toMatchObject({
      attemptCount: 0,
      maxAttempts: 10,
      revision: 1,
    });

    const corrupt = new SqlSessionExecutionCoordinator(fakeSql({
      row: executionRow({ generation: "not-an-integer" }),
    }));
    await expect(corrupt.find({
      workspaceId: "workspace_01",
      executionId: "execution_row",
    })).rejects.toThrow("Invalid execution generation");

    const malformedClaim = new SqlSessionExecutionCoordinator(fakeSql({
      row: executionRow(),
    }));
    await expect(malformedClaim.claim({
      ownerId: "node_a",
      attemptId: "attempt_a",
      claimedAt: at(2),
      leaseTtlMs: 1_000,
    })).rejects.toThrow("Claimed Session Execution has no attempt");
  });

  it("fails admission if the inserted execution cannot be read back", async () => {
    const store = new SqlSessionExecutionCoordinator(fakeSql());
    store.find = async () => null;

    await expect(store.admit(admitted("vanished", "session_01", at(1))))
      .rejects.toThrow("vanished after admission");
  });

  it("rejects a malformed SQL batch response during session cancellation", async () => {
    const store = new SqlSessionExecutionCoordinator(fakeSql({ batchResults: [] }));

    await expect(store.cancelSession({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      cancelledAt: at(2),
      reason: "cancel",
    })).rejects.toThrow("two results");
  });

  it("upgrades an early preview table before creating the lane index", async () => {
    const legacy = await createBetterSqlite3SqlClient(":memory:");
    await legacy.exec(`
      CREATE TABLE managed_session_executions (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        admitted_at_ms BIGINT NOT NULL,
        events_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_id TEXT,
        owner_id TEXT,
        PRIMARY KEY (workspace_id, id)
      )
    `);
    await ensureSessionExecutionCoordinatorSchema(legacy);
    const columns = await legacy
      .prepare("PRAGMA table_info(managed_session_executions)")
      .all<{ name: string }>();
    expect(columns.results?.map((column) => column.name)).toEqual(
      expect.arrayContaining(["lane_id", "events_fingerprint", "deadline_at_ms"]),
    );
    const upgraded = new SqlSessionExecutionCoordinator(legacy);
    await expect(upgraded.admit(admitted("upgraded", "session_01", at(1))))
      .resolves.toMatchObject({ type: "admitted", execution: { laneId: "sthr_primary" } });
  });

  it("admits idempotent replays but exposes an identity collision", async () => {
    const input = admitted("execution_01", "session_01", at(1));
    await expect(coordinator.admit(input)).resolves.toMatchObject({
      type: "admitted",
      execution: { state: "queued", revision: 1 },
    });
    await expect(coordinator.admit(structuredClone(input))).resolves.toMatchObject({
      type: "replayed",
      execution: { id: "execution_01", revision: 1 },
    });
    await expect(
      coordinator.admit(admitted("execution_01", "session_01", at(1), "different")),
    ).resolves.toMatchObject({ type: "conflict" });
  });

  it("claims only each session's FIFO head while allowing other sessions to run", async () => {
    await coordinator.admit(admitted("a1", "session_a", at(1)));
    await coordinator.admit(admitted("a2", "session_a", at(2)));
    await coordinator.admit(admitted("b1", "session_b", at(3)));

    const first = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a1",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    });
    const second = await coordinator.claim({
      ownerId: "node_b",
      attemptId: "attempt_b1",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    });
    const third = await coordinator.claim({
      ownerId: "node_c",
      attemptId: "attempt_none",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    });

    expect(first).toMatchObject({
      type: "claimed",
      execution: { id: "a1", sessionId: "session_a" },
    });
    expect(second).toMatchObject({
      type: "claimed",
      execution: { id: "b1", sessionId: "session_b" },
    });
    expect(third).toEqual({ type: "empty" });
  });

  it("reclaims an expired lease and fences the stale attempt from renew and settle", async () => {
    await coordinator.admit(admitted("execution_01", "session_01", at(1)));
    const first = await coordinator.claim({
      ownerId: "node_old",
      attemptId: "attempt_old",
      claimedAt: at(2),
      leaseTtlMs: 2_000,
    });
    expect(first.type).toBe("claimed");
    if (first.type !== "claimed") return;

    const reclaimed = await coordinator.claim({
      ownerId: "node_new",
      attemptId: "attempt_new",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    });
    expect(reclaimed).toMatchObject({
      type: "claimed",
      fence: { generation: 2, ownerId: "node_new", attemptId: "attempt_new" },
    });
    await expect(coordinator.renew({
      fence: first.fence,
      renewedAt: at(5),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "lost" });
    await expect(coordinator.settle({
      fence: first.fence,
      settledAt: at(5),
      outcome: "completed",
    })).resolves.toEqual({ type: "lost" });
  });

  it("never lets one live worker reclaim its own expired in-flight attempt", async () => {
    await coordinator.admit(admitted("execution_01", "session_01", at(1)));
    await coordinator.claim({
      ownerId: "node_live",
      attemptId: "attempt_old",
      claimedAt: at(2),
      leaseTtlMs: 1_000,
    });

    await expect(coordinator.claim({
      ownerId: "node_live",
      attemptId: "attempt_duplicate",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "empty" });
    await expect(coordinator.claim({
      ownerId: "node_replacement",
      attemptId: "attempt_replacement",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({
      type: "claimed",
      fence: { ownerId: "node_replacement", generation: 2 },
    });
  });

  it("terminalizes poison work after its attempt budget is exhausted", async () => {
    await coordinator.admit({
      ...admitted("poison", "session_a", at(1)),
      policy: { maxAttempts: 1, timeoutMs: 60_000 },
    });
    await coordinator.claim({
      ownerId: "dead_node",
      attemptId: "attempt_1",
      claimedAt: at(2),
      leaseTtlMs: 1_000,
    });

    await expect(coordinator.claim({
      ownerId: "replacement",
      attemptId: "attempt_2",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "empty" });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "poison",
    })).resolves.toMatchObject({
      state: "failed",
      attemptCount: 1,
      maxAttempts: 1,
      failure: "execution attempt limit exhausted",
    });
  });

  it("never claims or renews work beyond its absolute deadline", async () => {
    await coordinator.admit({
      ...admitted("expired_before_claim", "session_a", at(1)),
      policy: { maxAttempts: 3, timeoutMs: 1_000 },
    });
    await expect(coordinator.claim({
      ownerId: "node_a",
      attemptId: "late_attempt",
      claimedAt: at(3),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "empty" });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "expired_before_claim",
    })).resolves.toMatchObject({
      state: "failed",
      failure: "execution deadline exceeded",
      deadlineAt: at(2),
    });

    await coordinator.admit({
      ...admitted("expires_running", "session_b", at(4)),
      policy: { maxAttempts: 3, timeoutMs: 2_000 },
    });
    const claimed = await coordinator.claim({
      ownerId: "node_b",
      attemptId: "attempt_running",
      claimedAt: at(5),
      leaseTtlMs: 30_000,
    });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;
    await expect(coordinator.renew({
      fence: claimed.fence,
      renewedAt: at(6),
      leaseTtlMs: 30_000,
    })).resolves.toEqual({ type: "lost" });
  });

  it("delivers a durable interrupt through heartbeat and advances after settlement", async () => {
    await coordinator.admit(admitted("a1", "session_a", at(1)));
    const claimed = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a1",
      claimedAt: at(3),
      leaseTtlMs: 30_000,
    });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;

    await expect(coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      requestedAt: at(4),
    })).resolves.toEqual({ type: "requested" });
    const renewed = await coordinator.renew({
      fence: claimed.fence,
      renewedAt: at(5),
      leaseTtlMs: 30_000,
    });
    expect(renewed).toMatchObject({
      type: "renewed",
      interruptRequestedAt: at(4),
    });
    const fence = renewed.type === "renewed" ? renewed.fence : claimed.fence;
    await expect(coordinator.settle({
      fence,
      settledAt: at(6),
      outcome: "cancelled",
    })).resolves.toMatchObject({
      type: "settled",
      execution: { state: "cancelled", settledAt: at(6) },
    });

    await coordinator.admit(admitted("a2", "session_a", at(7)));

    await expect(coordinator.claim({
      ownerId: "node_b",
      attemptId: "attempt_a2",
      claimedAt: at(8),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({
      type: "claimed",
      execution: { id: "a2" },
    });
  });

  it("keeps queued work, keeps the first interrupt intent, and terminalizes an expired owner", async () => {
    await coordinator.admit(admitted("active", "session_a", at(1)));
    await coordinator.admit(admitted("queued", "session_a", at(2)));
    await coordinator.claim({
      ownerId: "dead_node",
      attemptId: "dead_attempt",
      claimedAt: at(3),
      leaseTtlMs: 1_000,
    });

    await expect(coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      requestedAt: at(5),
    })).resolves.toEqual({ type: "requested" });
    await coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      requestedAt: at(6),
    });

    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "active",
    })).resolves.toMatchObject({
      state: "cancelled",
      interruptRequestedAt: at(5),
      settledAt: at(5),
    });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "queued",
    })).resolves.toMatchObject({ state: "queued", settledAt: null });
    // The queued item survives the interrupt and drains next.
    await expect(coordinator.claim({
      ownerId: "replacement",
      attemptId: "replacement_attempt",
      claimedAt: at(7),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({ type: "claimed", execution: { id: "queued" } });
  });

  it("removes one queued execution and refuses to cancel started work", async () => {
    await coordinator.admit(admitted("running", "session_q", at(1)));
    await coordinator.admit(admitted("queued_a", "session_q", at(2)));
    await coordinator.admit(admitted("queued_b", "session_q", at(3)));
    await coordinator.claim({ ownerId: "node", attemptId: "a1", claimedAt: at(4), leaseTtlMs: 30_000 });
    await expect(coordinator.cancelQueued({
      workspaceId: "workspace_01", sessionId: "session_q", executionId: "running", cancelledAt: at(5),
    })).resolves.toMatchObject({ type: "not_queued", reason: "already_processing" });
    await expect(coordinator.cancelQueued({
      workspaceId: "workspace_01", sessionId: "session_q", executionId: "queued_a", cancelledAt: at(5),
    })).resolves.toMatchObject({ type: "cancelled", execution: { id: "queued_a", state: "cancelled" } });
    await expect(coordinator.cancelQueued({
      workspaceId: "workspace_01", sessionId: "session_q", executionId: "queued_a", cancelledAt: at(6),
    })).resolves.toMatchObject({ type: "not_queued", reason: "already_cancelled" });
    await expect(coordinator.find({ workspaceId: "workspace_01", executionId: "queued_b" }))
      .resolves.toMatchObject({ state: "queued" });
  });

  it("cancelQueued response discriminates cancelled vs already_processing for the edit race", async () => {
    await coordinator.admit(admitted("q_late", "session_c", at(1)));
    await coordinator.admit(admitted("q_ok", "session_c", at(2)));
    // Claim drains FIFO: q_late becomes running; q_ok stays queued.
    await coordinator.claim({ ownerId: "host", attemptId: "a1", claimedAt: at(3), leaseTtlMs: 30_000 });
    const ok = await coordinator.cancelQueued({
      workspaceId: "workspace_01", sessionId: "session_c", executionId: "q_ok", cancelledAt: at(4),
    });
    expect(ok).toMatchObject({ type: "cancelled", execution: { id: "q_ok", state: "cancelled" } });
    // HTTP shape the Console branches on: cancelled true vs false + reason.
    expect({ cancelled: true as const, id: "q_ok", cancelled_at: at(4) }.cancelled).toBe(true);
    const late = await coordinator.cancelQueued({
      workspaceId: "workspace_01", sessionId: "session_c", executionId: "q_late", cancelledAt: at(5),
    });
    expect(late).toMatchObject({ type: "not_queued", reason: "already_processing", execution: { id: "q_late", state: "running" } });
    const httpLate = {
      cancelled: false as const,
      reason: late.type === "not_queued" ? late.reason : "not_found",
      id: "q_late",
      processed_at: late.type === "not_queued"
        ? (late.execution?.attempt?.claimedAt ?? late.execution?.settledAt ?? undefined)
        : undefined,
    };
    expect(httpLate).toMatchObject({ cancelled: false, reason: "already_processing", id: "q_late" });
    expect(httpLate.processed_at).toBeTruthy();
  });

  it("edit race: cancel after the item was promoted is rejected and the original runs unchanged", async () => {
    await coordinator.admit(admitted("queued_edit", "session_r", at(1)));
    // The host dequeues the item while the user is still editing it.
    const claimed = await coordinator.claim({ ownerId: "host", attemptId: "a1", claimedAt: at(2), leaseTtlMs: 30_000 });
    expect(claimed).toMatchObject({ type: "claimed", execution: { id: "queued_edit" } });
    await expect(coordinator.cancelQueued({
      workspaceId: "workspace_01", sessionId: "session_r", executionId: "queued_edit", cancelledAt: at(3),
    })).resolves.toMatchObject({ type: "not_queued", reason: "already_processing" });
    await expect(coordinator.find({ workspaceId: "workspace_01", executionId: "queued_edit" }))
      .resolves.toMatchObject({ state: "running" });
  });

  it("edit race: cancel after steer is rejected", async () => {
    await coordinator.admit(admitted("queued_steer", "session_r", at(1)));
    await expect(coordinator.steerQueued({
      workspaceId: "workspace_01", sessionId: "session_r", executionId: "queued_steer", steeredAt: at(2),
    })).resolves.toMatchObject({ type: "steered" });
    await expect(coordinator.cancelQueued({
      workspaceId: "workspace_01", sessionId: "session_r", executionId: "queued_steer", cancelledAt: at(3),
    })).resolves.toMatchObject({ type: "not_queued", reason: "already_completed" });
  });

  it("edit race: concurrent claim and cancel have exactly one winner", async () => {
    await coordinator.admit(admitted("queued_both", "session_r", at(1)));
    const [claim, cancel] = await Promise.all([
      coordinator.claim({ ownerId: "host", attemptId: "a1", claimedAt: at(2), leaseTtlMs: 30_000 }),
      coordinator.cancelQueued({
        workspaceId: "workspace_01", sessionId: "session_r", executionId: "queued_both", cancelledAt: at(2),
      }),
    ]);
    const claimWon = claim.type === "claimed";
    const cancelWon = cancel.type === "cancelled";
    expect(claimWon !== cancelWon).toBe(true);
    const row = await coordinator.find({ workspaceId: "workspace_01", executionId: "queued_both" });
    expect(row?.state).toBe(claimWon ? "running" : "cancelled");
  });

  it("has a single atomic winner when replicas race for one execution", async () => {
    await coordinator.admit(admitted("execution_01", "session_01", at(1)));
    const results = await Promise.all([
      coordinator.claim({
        ownerId: "node_a",
        attemptId: "attempt_a",
        claimedAt: at(2),
        leaseTtlMs: 30_000,
      }),
      coordinator.claim({
        ownerId: "node_b",
        attemptId: "attempt_b",
        claimedAt: at(2),
        leaseTtlMs: 30_000,
      }),
    ]);
    expect(results.filter((result) => result.type === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.type === "empty")).toHaveLength(1);
  });

  it("rejects a settlement after the current lease has expired", async () => {
    await coordinator.admit(admitted("execution_01", "session_01", at(1)));
    const claimed = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a",
      claimedAt: at(2),
      leaseTtlMs: 1_000,
    });
    expect(claimed.type).toBe("claimed");
    if (claimed.type !== "claimed") return;
    await expect(coordinator.settle({
      fence: claimed.fence,
      settledAt: at(4),
      outcome: "completed",
    })).resolves.toEqual({ type: "lost" });
  });

  it("does not let an idle interrupt leak into a later execution", async () => {
    await expect(coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      requestedAt: at(1),
    })).resolves.toEqual({ type: "idle" });
    await coordinator.admit(admitted("execution_01", "session_01", at(2)));
    const claimed = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a",
      claimedAt: at(3),
      leaseTtlMs: 30_000,
    });
    expect(claimed).toMatchObject({
      type: "claimed",
      execution: { interruptRequestedAt: null },
    });
  });

  it("atomically fences queued and running executions for a deleted session", async () => {
    await coordinator.admit(admitted("a1", "session_a", at(1)));
    await coordinator.admit(admitted("a2", "session_a", at(2)));
    await coordinator.admit(admitted("b1", "session_b", at(3)));
    const claimed = await coordinator.claim({
      ownerId: "node_a",
      attemptId: "attempt_a1",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    });
    expect(claimed).toMatchObject({ type: "claimed", execution: { id: "a1" } });

    await expect(coordinator.cancelSession({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      cancelledAt: at(5),
      reason: "session deleted",
    })).resolves.toEqual({ queued: 1, running: 1 });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "a1",
    })).resolves.toMatchObject({ state: "cancelled", failure: "session deleted" });
    await expect(coordinator.find({
      workspaceId: "workspace_01",
      executionId: "a2",
    })).resolves.toMatchObject({ state: "cancelled", failure: "session deleted" });
    await expect(coordinator.claim({
      ownerId: "node_b",
      attemptId: "attempt_b1",
      claimedAt: at(6),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({ type: "claimed", execution: { id: "b1" } });
  });
});

sessionExecutionStoreConformance("better-sqlite3", {
  async withStore(_fixtureId, run) {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureSessionExecutionCoordinatorSchema(sql);
    return run(new SqlSessionExecutionCoordinator(sql));
  },
});
