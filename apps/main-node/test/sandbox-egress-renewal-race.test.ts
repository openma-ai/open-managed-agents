// Two exec-boundary renewals at once (#561 race table F): the Cloudflare
// alarm (renewActivityTimeout) and an exec call, both finding the egress
// binding stale because a new execution attempt claimed the Session. With
// egressRenewMs: null the only egress renewal is that re-attach (attempt
// changed, or after a revoke) — never a timer. The attach is gated; each attach
// issues one real sandbox token into SQLite for the current attempt.
import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql/coordination";
import { createSqlSandboxTokenStore } from "../../../packages/sandbox-gateway-sql/src/index";
import { authenticateSandboxToken, issueSandboxToken, type SessionExecutionAttemptRef } from "../../../packages/sandbox-gateway/src/index";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
import { attempt, fakeSessionSandbox } from "../../../packages/session-runtime/test/fake-session-sandbox-ports";

async function database() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureSessionExecutionCoordinatorSchema(sql);
  await sql.exec(`CREATE TABLE managed_sessions (
      workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL, revision integer NOT NULL,
      agent_id text NOT NULL, agent_version integer NOT NULL, environment_id text NOT NULL, status text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer, PRIMARY KEY (workspace_id, id));
    CREATE TABLE managed_environments (
      workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL, revision integer NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer, PRIMARY KEY (workspace_id, id));`);
  return sql;
}

async function setup() {
  const sql = await database();
  const executions = new SqlSessionExecutionCoordinator(sql);
  const store = createSqlSandboxTokenStore(sql);
  await seedSandboxGatewaySessionRows(sql, "ws", { id: "sess", environmentId: "env", vaultIds: ["vlt"], agent: { id: "agent", version: 1 }, archivedAt: null });
  const claim = async (n: number) => {
    const now = new Date().toISOString();
    await executions.admit({ execution: { id: `exec_${n}`, workspaceId: "ws", sessionId: "sess", admittedAt: now, events: [{ id: `evt_${n}`, type: "user.message", content: [], processedAt: now }] } });
    const claimed = await executions.claim({ workspaceId: "ws", sessionId: "sess", ownerId: `owner_${n}`, attemptId: `att_${n}`, claimedAt: now, leaseTtlMs: 60_000 });
    if (claimed.type !== "claimed") throw new Error("expected a claim");
    return claimed.fence;
  };
  let fence: SessionExecutionAttemptRef = await claim(1);
  const issued: string[] = [];
  let gate: { reached(): void; released: Promise<void> } | null = null;
  const h = fakeSessionSandbox({
    egressAttach: async () => {
      const held = gate; gate = null;
      if (held !== null) { held.reached(); await held.released; }
      issued.push(await issueSandboxToken(store, fence, { scope: "egress" }));
    },
  });
  const hold = () => {
    let reached!: () => void; let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    gate = { reached, released: new Promise<void>((resolve) => { release = resolve; }) };
    return { reached: reachedPromise, release };
  };
  const nextAttempt = async () => {
    await executions.settle({ fence: fence as never, settledAt: new Date().toISOString(), outcome: "completed" });
    fence = await claim(2);
    h.setExecution({ ...attempt, executionId: "exec_2", attemptId: "att_2", ownerId: "owner_2", generation: fence.generation });
  };
  const hashes = async (executionId: string) => {
    const row = await sql.prepare("SELECT sandbox_token_hashes FROM managed_session_executions WHERE workspace_id = ? AND id = ?").bind("ws", executionId).first<{ sandbox_token_hashes: string | null }>();
    return row?.sandbox_token_hashes === null || row === null ? [] : JSON.parse(row.sandbox_token_hashes) as unknown[];
  };
  const egress = (token: string) => authenticateSandboxToken(store, { sessionId: "sess", token, channel: "egress" }).then((decision) => decision.type);
  return { h, issued, hold, nextAttempt, hashes, egress };
}
const attaches = (log: readonly string[]) => log.filter((entry) => entry === "egress.attach").length;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("parallel exec-boundary renewals (alarm + exec), real SQLite token store", () => {
  it.each(["exec first", "alarm first"] as const)("F: %s holds the re-attach; the other joins it — one attach, one token on the new attempt", async (order) => {
    const f = await setup();
    await f.h.sandbox.exec("open");
    expect(attaches(f.h.log)).toBe(1); expect(f.issued).toHaveLength(1);
    await f.nextAttempt();
    const held = f.hold();
    const firstCall = order === "exec first" ? f.h.sandbox.exec("a") : f.h.sandbox.renewActivityTimeout();
    await held.reached; // the first renewal is inside egress.attach
    const keepAlives = f.h.log.filter((entry) => entry === "keepAlive").length;
    const secondCall = order === "exec first" ? f.h.sandbox.renewActivityTimeout() : f.h.sandbox.exec("b");
    await flush(); // the second renewal has run up to the shared single-flight
    if (order === "exec first") expect(f.h.log.filter((entry) => entry === "keepAlive").length).toBe(keepAlives + 1);
    expect(attaches(f.h.log)).toBe(2);
    held.release();
    await Promise.all([firstCall, secondCall]);
    expect(attaches(f.h.log)).toBe(2); // exactly one re-attach for the attempt change
    expect(f.issued).toHaveLength(2);
    expect(await f.hashes("exec_1")).toEqual([]); // the settled attempt holds nothing
    expect(await f.hashes("exec_2")).toHaveLength(1);
    expect(await f.egress(f.issued[0]!)).toBe("rejected");
    expect(await f.egress(f.issued[1]!)).toBe("accepted");
    // No timer renewal: later calls on the same attempt do not re-attach.
    f.h.advance(24 * 60 * 60 * 1000);
    await f.h.sandbox.exec("later"); await f.h.sandbox.renewActivityTimeout();
    expect(attaches(f.h.log)).toBe(2);
  });
});
