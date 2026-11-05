// Shared cross-dialect driver for optional SQL filter parameters.
//
// PostgreSQL infers every placeholder's type at parse time. postgres.js sends
// JS strings/numbers/null as type 0 (unknown), so a placeholder that only
// appears in `? IS NULL` has no inference context and the statement fails
// with 42P18 ("could not determine data type of parameter"), whatever value
// is bound. SQLite never types placeholders. The portable shape is
// `(? = 1 OR col = ?)` bound as `value == null ? 1 : 0, value`.
//
// Each dialect runs the same real stores against a migrated database and
// must produce exactly OPTIONAL_FILTER_SNAPSHOT, which is the row-level
// parity check across SQLite, PostgreSQL, and MySQL.

import type { SqlClient } from "@open-managed-agents/sql-client";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionCoordinator,
} from "@open-managed-agents/session-runtime-sql";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { SentSessionEvent } from "@open-managed-agents/domain/sessions";
import { SqlSessionEventStore } from "../../../../packages/session-event-store-sql/src/index.js";
import { NodeManagedWorkspaceCheckpoints } from "../../../../packages/control-plane-node/src/lib/node-managed-workspace-checkpoints.js";

export type Dialect = "sqlite" | "postgres" | "mysql";

const T = Date.UTC(2026, 10, 1);
const iso = (offsetMs: number) => new Date(T + offsetMs).toISOString();

export async function prepareOptionalFilterSchema(sql: SqlClient, dialect: Dialect): Promise<void> {
  // Mirrors node-managed boot: the baseline may predate additive columns.
  await ensureSessionExecutionCoordinatorSchema(sql, dialect);
  await checkpoints(sql).ensureSchema();
}

async function reset(sql: SqlClient): Promise<void> {
  for (const table of [
    "managed_session_workspace_checkpoints",
    "managed_session_executions",
    "managed_session_events",
    "managed_sessions",
  ]) {
    await sql.prepare(`DELETE FROM ${table}`).run();
  }
}

function checkpoints(sql: SqlClient): NodeManagedWorkspaceCheckpoints {
  return new NodeManagedWorkspaceCheckpoints({
    sql, blobs: {} as never, intervalMs: 30_000, nowMs: () => T + 2_000,
  });
}

async function insertSession(sql: SqlClient, workspaceId: string, id: string): Promise<void> {
  await sql.prepare(
    `INSERT INTO managed_sessions
      (id, workspace_id, document, revision, agent_id, agent_version,
       environment_id, status, created_at, updated_at)
     VALUES (?, ?, '{}', 1, 'agent_1', 1, 'env_1', 'running', ?, ?)`,
  ).bind(id, workspaceId, T, T).run();
}

async function insertRunning(
  sql: SqlClient,
  row: { workspaceId: string; sessionId: string; id: string; laneId: string; leaseExpiresAtMs: number },
): Promise<void> {
  await sql.prepare(
    `INSERT INTO managed_session_executions
      (workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
       events_fingerprint, state, attempt_id, owner_id, generation,
       attempt_count, max_attempts, deadline_at_ms, claimed_at_ms,
       lease_expires_at_ms, revision)
     VALUES (?, ?, ?, ?, ?, '[]', '[]', 'running', 'attempt_x', 'owner_x', 1,
             1, 10, ?, ?, ?, 1)`,
  ).bind(
    row.workspaceId, row.sessionId, row.laneId, row.id, T,
    T + 3_600_000, T, row.leaseExpiresAtMs,
  ).run();
}

async function executionRows(sql: SqlClient, sessionIds: readonly string[]) {
  const rows = await sql.prepare(
    `SELECT session_id, id, lane_id, state, interrupt_requested_at_ms, failure, events_json
       FROM managed_session_executions
      WHERE session_id IN (${sessionIds.map(() => "?").join(", ")})
      ORDER BY session_id, id`,
  ).bind(...sessionIds).all<{
    session_id: string; id: string; lane_id: string; state: string;
    interrupt_requested_at_ms: number | string | null; failure: string | null; events_json: string;
  }>();
  return (rows.results ?? []).map((row) => ({
    session: row.session_id,
    id: row.id,
    lane: row.lane_id,
    state: row.state,
    interruptRequestedAtMs: row.interrupt_requested_at_ms === null ? null : Number(row.interrupt_requested_at_ms),
    failure: row.failure,
    events: (JSON.parse(row.events_json) as Array<{ id: string }>).map((event) => event.id),
  }));
}

/** a. Event-store interrupt: lane filter set (thread interrupt) and omitted (session interrupt). */
async function eventStoreLaneFilter(sql: SqlClient) {
  await reset(sql);
  const store = new SqlSessionEventStore(sql, { executionOutbox: true });
  const lanes = [
    ["exec_a", "sthr_a", T + 1_000],
    ["exec_b", "sthr_b", T + 60_000],
    ["exec_c", "sthr_c", T + 60_000],
    ["exec_d", "sthr_d", T + 1_000],
  ] as const;
  for (const sessionId of ["s_lane", "s_all"]) {
    await insertSession(sql, "w_a", sessionId);
    for (const [id, laneId, leaseExpiresAtMs] of lanes) {
      await insertRunning(sql, { workspaceId: "w_a", sessionId, id: `${sessionId}_${id}`, laneId, leaseExpiresAtMs });
    }
  }
  const append = (sessionId: string, events: unknown[]) => store.append({
    workspaceId: "w_a", sessionId, expectedRevision: 1,
    events: events as SentSessionEvent[],
    nextSession: { id: sessionId, environmentId: "env_1", status: "running", updatedAt: iso(5_000) } as never,
  });
  const laneSet = await append("s_lane", [
    { id: "evt_int_a", type: "user.interrupt", sessionThreadId: "sthr_a" },
    { id: "evt_int_b", type: "user.interrupt", sessionThreadId: "sthr_b" },
  ]);
  const laneOmitted = await append("s_all", [{ id: "evt_int_all", type: "user.interrupt" }]);
  return {
    appended: [laneSet.type, laneOmitted.type],
    rows: await executionRows(sql, ["s_all", "s_lane"]),
  };
}

/** b. Workspace checkpoint pointer CAS: expected null and expected set. */
async function checkpointCas(sql: SqlClient) {
  await reset(sql);
  const coordinator = new SqlSessionExecutionCoordinator(sql);
  await coordinator.admit({ execution: {
    id: "exec_ck", workspaceId: "w_b", sessionId: "s_ck", admittedAt: iso(0),
    events: [{ id: "evt_ck", type: "user.message", content: [{ type: "text", text: "hi" }] }] as never,
  } });
  const claim = await coordinator.claim({
    workspaceId: "w_b", sessionId: "s_ck", ownerId: "owner_b", attemptId: "attempt_b",
    claimedAt: iso(1_000), leaseTtlMs: 120_000,
  });
  if (claim.type !== "claimed") throw new Error("checkpoint fixture did not claim");
  const fence: SessionExecutionFence = claim.fence;
  const publisher = checkpoints(sql);
  const candidate = (id: string) => ({
    id,
    contentHash: `sha256:${"a".repeat(64)}`,
    revision: 1,
    metadata: {
      "openma.workspace.blob-key.v1":
        `managed-session-workspace-checkpoints/w_b/s_ck/${id}.tar`,
    },
  });
  const publish = (id: string, expectedId: string | null) =>
    publisher.publish({ fence, candidate: candidate(id), expectedId });
  const results = {
    firstExpectedNull: await publish("wsc_1", null),
    secondExpectedNullStale: await publish("wsc_2", null),
    expectedWrongId: await publish("wsc_2", "wsc_other"),
    expectedCurrentId: await publish("wsc_2", "wsc_1"),
    expectedPreviousIdStale: await publish("wsc_3", "wsc_1"),
  };
  const pointer = await sql.prepare(
    `SELECT candidate_id, revision FROM managed_session_workspace_checkpoints
      WHERE workspace_id = ? AND session_id = ?`,
  ).bind("w_b", "s_ck").first<{ candidate_id: string | null; revision: number | string }>();
  return {
    results,
    pointer: { candidateId: pointer?.candidate_id ?? null, revision: Number(pointer?.revision) },
  };
}

/** c. Coordination claim, held-absorb, and interrupt with optional workspace/session/lane filters. */
async function coordinationFilters(sql: SqlClient) {
  await reset(sql);
  const coordinator = new SqlSessionExecutionCoordinator(sql);
  const admit = (id: string, workspaceId: string, sessionId: string, laneId: string, at: number) =>
    coordinator.admit({ execution: {
      id, workspaceId, sessionId, laneId, admittedAt: iso(at),
      events: [{ id: `evt_${id}`, type: "user.message", content: [{ type: "text", text: id }] }] as never,
    } });
  await admit("exec_held_1", "w1", "s4", "sthr_primary", -20);
  await admit("exec_held_2", "w2", "s5", "sthr_primary", -10);
  await admit("exec_a1", "w1", "s1", "sthr_l1", 0);
  await admit("exec_a2", "w1", "s1", "sthr_l2", 1);
  await admit("exec_b1", "w1", "s2", "sthr_primary", 2);
  await admit("exec_c1", "w2", "s3", "sthr_primary", 3);
  await admit("exec_n1", "w1", "s4", "sthr_primary", 4);
  await admit("exec_n2", "w2", "s5", "sthr_primary", 5);
  await coordinator.markHeldAfterExhausted({ workspaceId: "w1", sessionId: "s4", executionId: "exec_held_1", heldAt: new Date(T) });
  await coordinator.markHeldAfterExhausted({ workspaceId: "w2", sessionId: "s5", executionId: "exec_held_2", heldAt: new Date(T) });
  let attempt = 0;
  const claim = async (filters: { workspaceId?: string; sessionId?: string; laneId?: string }) => {
    attempt += 1;
    const result = await coordinator.claim({
      ...filters, ownerId: "owner_c", attemptId: `attempt_${attempt}`,
      claimedAt: iso(1_000), leaseTtlMs: 60_000,
    });
    return result.type === "claimed" ? result.fence.executionId : "empty";
  };
  const claims = {
    workspaceOnly: await claim({ workspaceId: "w2" }),
    allSet: await claim({ workspaceId: "w1", sessionId: "s1", laneId: "sthr_l2" }),
    absorbScoped: await claim({ workspaceId: "w1", sessionId: "s4" }),
    allOmitted: await claim({}),
    absorbedByOmittedThenWorkspace: await claim({ workspaceId: "w2" }),
    remaining: await claim({ workspaceId: "w1" }),
    drained: await claim({}),
  };
  const interrupts = {
    laneSet: (await coordinator.requestInterrupt({ workspaceId: "w1", sessionId: "s1", laneId: "sthr_l1", requestedAt: iso(2_000) })).type,
    laneOmitted: (await coordinator.requestInterrupt({ workspaceId: "w1", sessionId: "s2", requestedAt: iso(2_000) })).type,
    laneMissing: (await coordinator.requestInterrupt({ workspaceId: "w2", sessionId: "s3", laneId: "sthr_none", requestedAt: iso(2_000) })).type,
  };
  return {
    claims,
    interrupts,
    rows: await executionRows(sql, ["s1", "s2", "s3", "s4", "s5"]),
  };
}

export async function runOptionalFilterScenarios(sql: SqlClient) {
  return {
    eventStore: await eventStoreLaneFilter(sql),
    checkpoint: await checkpointCas(sql),
    coordination: await coordinationFilters(sql),
  };
}

export type LegacyProbe =
  | { ok: true; rows: number; expected: number }
  | { ok: false; code: string | null; message: string; expected: number };

/**
 * Run the retired `(? IS NULL OR …)` shapes verbatim next to the 0/1-flag
 * shape on seeded rows, so each dialect's behavior (error vs. silently
 * different rows) is recorded as evidence rather than assumed.
 */
export async function probeLegacyIsNullPatterns(sql: SqlClient): Promise<Record<string, LegacyProbe>> {
  await reset(sql);
  for (const [id, laneId] of [["p1", "sthr_l1"], ["p2", "sthr_l1"], ["p3", "sthr_l2"]] as const) {
    await insertRunning(sql, { workspaceId: "w_p", sessionId: "s_p", id, laneId, leaseExpiresAtMs: T });
  }
  for (const [sessionId, candidateId] of [["s_null", null], ["s_set", "wsc_2"], ["s_other", "wsc_9"]] as const) {
    await sql.prepare(
      `INSERT INTO managed_session_workspace_checkpoints
        (workspace_id, session_id, candidate_id, candidate_json, published_at_ms, revision)
       VALUES ('w_p', ?, ?, NULL, NULL, 0)`,
    ).bind(sessionId, candidateId).run();
  }
  const count = async (text: string, params: unknown[]) =>
    ((await sql.prepare(text).bind(...params).all<Record<string, unknown>>()).results ?? []).length;
  const probe = async (legacy: string, portable: string, value: string | null): Promise<LegacyProbe> => {
    const expected = await count(portable, [value === null ? 1 : 0, value]);
    try {
      return { ok: true, rows: await count(legacy, [value, value]), expected };
    } catch (error) {
      return { ok: false, code: errorCode(error), message: String((error as Error).message ?? error), expected };
    }
  };
  const lane = (head: string) => `SELECT id FROM managed_session_executions WHERE (${head} OR lane_id = ?)`;
  const cas = (head: string) => `SELECT session_id FROM managed_session_workspace_checkpoints
    WHERE ((${head} AND candidate_id IS NULL) OR candidate_id = ?)`;
  return {
    laneNull: await probe(lane("? IS NULL"), lane("? = 1"), null),
    laneSet: await probe(lane("? IS NULL"), lane("? = 1"), "sthr_l1"),
    casNull: await probe(cas("? IS NULL"), cas("? = 1"), null),
    casSet: await probe(cas("? IS NULL"), cas("? = 1"), "wsc_2"),
  };
}

/** Expected 0/1-flag row counts on the probe seed, identical for every dialect. */
export const PROBE_EXPECTED_ROWS = { laneNull: 3, laneSet: 2, casNull: 1, casSet: 1 };

function errorCode(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (typeof record.code === "string" && record.code.length > 0) return record.code;
    current = record.cause;
  }
  return null;
}

const executions = (
  session: string,
  rows: Array<[id: string, lane: string, state: string, interruptRequestedAtMs: number | null, failure: string | null, events?: string[]]>,
) => rows.map(([id, lane, state, interruptRequestedAtMs, failure, events]) => ({
  session, id, lane, state, interruptRequestedAtMs, failure, events: events ?? [],
}));

const EXPIRED = "interrupted after owner lease expired";
const AT_5S = T + 5_000;
const AT_2S = T + 2_000;

/** Golden rows, identical for every dialect. */
export const OPTIONAL_FILTER_SNAPSHOT = {
  eventStore: {
    appended: ["appended", "appended"],
    rows: [
      // Lane omitted: every running lane of the Session is interrupted.
      ...executions("s_all", [
        ["s_all_exec_a", "sthr_a", "cancelled", AT_5S, EXPIRED],
        ["s_all_exec_b", "sthr_b", "running", AT_5S, null],
        ["s_all_exec_c", "sthr_c", "running", AT_5S, null],
        ["s_all_exec_d", "sthr_d", "cancelled", AT_5S, EXPIRED],
      ]),
      // Lanes a+b set: c and d are untouched.
      ...executions("s_lane", [
        ["s_lane_exec_a", "sthr_a", "cancelled", AT_5S, EXPIRED],
        ["s_lane_exec_b", "sthr_b", "running", AT_5S, null],
        ["s_lane_exec_c", "sthr_c", "running", null, null],
        ["s_lane_exec_d", "sthr_d", "running", null, null],
      ]),
    ],
  },
  checkpoint: {
    results: {
      firstExpectedNull: true,
      secondExpectedNullStale: false,
      expectedWrongId: false,
      expectedCurrentId: true,
      expectedPreviousIdStale: false,
    },
    pointer: { candidateId: "wsc_2", revision: 2 },
  },
  coordination: {
    claims: {
      workspaceOnly: "exec_c1",
      allSet: "exec_a2",
      absorbScoped: "exec_n1",
      allOmitted: "exec_a1",
      absorbedByOmittedThenWorkspace: "exec_n2",
      remaining: "exec_b1",
      drained: "empty",
    },
    interrupts: { laneSet: "requested", laneOmitted: "requested", laneMissing: "idle" },
    rows: [
      ...executions("s1", [
        ["exec_a1", "sthr_l1", "running", AT_2S, null, ["evt_exec_a1"]],
        ["exec_a2", "sthr_l2", "running", null, null, ["evt_exec_a2"]],
      ]),
      ...executions("s2", [["exec_b1", "sthr_primary", "running", AT_2S, null, ["evt_exec_b1"]]]),
      ...executions("s3", [["exec_c1", "sthr_primary", "running", null, null, ["evt_exec_c1"]]]),
      ...executions("s4", [
        ["exec_held_1", "sthr_primary", "completed", null, null, ["evt_exec_held_1"]],
        ["exec_n1", "sthr_primary", "running", null, null, ["evt_exec_held_1", "evt_exec_n1"]],
      ]),
      ...executions("s5", [
        ["exec_held_2", "sthr_primary", "completed", null, null, ["evt_exec_held_2"]],
        ["exec_n2", "sthr_primary", "running", null, null, ["evt_exec_held_2", "evt_exec_n2"]],
      ]),
    ],
  },
};
