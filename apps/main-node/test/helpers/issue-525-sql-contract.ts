import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql/coordination";
import { SqlSessionSandboxBindingStore } from "@open-managed-agents/session-runtime-sql/sandbox-binding";
import { sessionSandboxBindingConformance } from "../../../../packages/session-runtime-sql/test/sandbox-binding-conformance";
import { sessionExecutionStoreConformance } from "../../../../packages/session-runtime-contract/test/execution-store-conformance";
import { NodeSessionSandboxLifecycle } from "../../../../packages/control-plane-node/src/lib/node-session-sandbox-lifecycle";
import { NodeSessionSandboxLeaseWorker } from "../../../../packages/control-plane-node/src/lib/node-session-sandbox-lease-worker";

type Run = (sql: SqlClient, other: SqlClient) => Promise<void>;

/** Native fixtures own disposable databases. Never clean a caller's database. */
export function issue525SqlContract(dialect: "sqlite" | "postgres" | "mysql", withClients: (run: Run) => Promise<void>) {
  sessionSandboxBindingConformance(dialect, run => withClients(run));
  sessionExecutionStoreConformance(dialect, {
    withStore: async (_id, run) => {
      let result!: Awaited<ReturnType<typeof run>>;
      await withClients(async sql => { result = await run(new SqlSessionExecutionCoordinator(sql)); });
      return result;
    },
  });

  describe(`#525 independent fences and FIFO: ${dialect}`, () => {
    const at = (n: number) => new Date(1_000_000 + n * 1000).toISOString();
    const input = (id: string, n: number, laneId = "sthr_primary") => ({ execution: {
      workspaceId: "workspace", sessionId: "session", id, laneId, admittedAt: at(n),
      events: [{ id, type: "user.message" as const, processedAt: null, content: [{ type: "text" as const, text: id }] }],
    } });

    it("serializes cross-lane claims on independent connections and orders admission despite reversed clocks", () => withClients(async (sql, other) => {
      const first = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
      const second = new SqlSessionExecutionCoordinator(other, { serializeSessionClaims: true });
      await first.admit(input("first", 3));
      await second.admit(input("second", 1, "sthr_child"));
      const claim = (store: SqlSessionExecutionCoordinator, ownerId: string, n: number) => store.claim({
        workspaceId: "workspace", sessionId: "session", ownerId, attemptId: `${ownerId}-${n}`, claimedAt: at(n), leaseTtlMs: 2000,
      });
      const results = await Promise.all([claim(first, "a", 4), claim(second, "b", 4)]);
      expect(results.filter(r => r.type === "claimed")).toHaveLength(1);
      const winner = results.find(r => r.type === "claimed")!;
      if (winner.type !== "claimed") throw new Error("Expected winner");
      expect(winner.execution.id).toBe("first");
      const replacement = await claim(second, "replacement", 7);
      expect(replacement).toMatchObject({ type: "claimed", execution: { id: "first" }, fence: { generation: 2 } });
      if (replacement.type !== "claimed") throw new Error("Expected takeover");
      expect(await first.settle({ fence: winner.fence, settledAt: at(7), outcome: "completed" })).toEqual({ type: "lost" });
      await second.settle({ fence: replacement.fence, settledAt: at(8), outcome: "completed" });
      expect(await claim(first, "next", 9)).toMatchObject({ type: "claimed", execution: { id: "second" } });
    }));

    it("atomically absorbs held inputs once under two concurrent claimers", () => withClients(async (sql, other) => {
      const first = new SqlSessionExecutionCoordinator(sql, { serializeSessionClaims: true });
      const second = new SqlSessionExecutionCoordinator(other, { serializeSessionClaims: true });
      await first.admit(input("initial", 0));
      const initial = await first.claim({ ownerId: "a", attemptId: "initial", claimedAt: at(1), leaseTtlMs: 30_000 });
      if (initial.type !== "claimed") throw new Error("Expected initial claim");
      await first.admit(input("held-a", 2)); await first.admit(input("held-b", 3));
      await first.settle({ fence: initial.fence, settledAt: at(4), outcome: "failed", failure: "retries_exhausted", holdQueuedOnLane: true });
      await first.admit(input("fresh", 5));
      const results = await Promise.all([first, second].map((store, i) => store.claim({
        ownerId: `worker-${i}`, attemptId: `next-${i}`, claimedAt: at(6), leaseTtlMs: 30_000,
      })));
      expect(results.filter(r => r.type === "claimed")).toHaveLength(1);
      const winner = results.find(r => r.type === "claimed")!;
      if (winner.type !== "claimed") throw new Error("Expected fresh claim");
      expect(winner.execution.events.map(e => e.id)).toEqual(["held-a", "held-b", "fresh"]);
      for (const executionId of ["held-a", "held-b"]) {
        expect(await second.find({ workspaceId: "workspace", executionId })).toMatchObject({ state: "completed", heldAfterExhaustedAt: null });
      }
    }));

    it("rotates the resource-worker lease without an attempt and fences old completion while retaining unknown use", () => withClients(async (sql, other) => {
      let clock = 1_000_000; const now = () => new Date(clock);
      const store = new SqlSessionSandboxBindingStore(sql);
      const lifecycle = new NodeSessionSandboxLifecycle({ store, provider: "test", ownerId: "manager",
        allocationIsolation: true, runtimeBindingSupported: true, now });
      const scope = { workspaceId: "workspace", sessionId: "session" };
      const sandbox = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
      const opened = await lifecycle.open({ scope, configFingerprint: "config", create: async () => sandbox,
        resume: async () => sandbox, handle: () => ({ provider: "test", runtimeId: "physical" }), prepare: async () => {} });
      await sql.prepare(`UPDATE managed_session_sandbox_resources SET use_execution_id = 'old',
        use_attempt_id = 'old', use_owner_id = 'old', use_generation = 1, use_outcome = 'unknown'`).run();
      let oldDone!: () => void; let newDone!: () => void;
      const oldRenew = vi.fn(() => new Promise<void>(resolve => { oldDone = resolve; }));
      const newRenew = vi.fn(() => new Promise<void>(resolve => { newDone = resolve; }));
      const errors: unknown[] = [];
      const worker = (client: SqlClient, ownerId: string, renew: () => Promise<void>) => new NodeSessionSandboxLeaseWorker({
        sql: client, store: new SqlSessionSandboxBindingStore(client), provider: "test", providerNamespace: "test",
        ownerId, ttlMs: 30_000, now, renew, onError: error => errors.push(error),
      });
      const old = worker(sql, "old-manager", oldRenew); const next = worker(other, "new-manager", newRenew);
      await old.ensureSchema(dialect);
      try {
        const oldPoll = old.poll(); await vi.waitFor(() => expect(oldRenew).toHaveBeenCalledOnce());
        await next.poll(); expect(newRenew).not.toHaveBeenCalled();
        clock += 10_001;
        const nextPoll = next.poll(); await vi.waitFor(() => expect(newRenew).toHaveBeenCalledOnce());
        oldDone(); await oldPoll;
        expect(await sql.prepare("SELECT owner_id FROM managed_session_sandbox_lease_workers").first()).toEqual({ owner_id: "new-manager" });
        newDone(); await nextPoll;
        expect((await new SqlSessionSandboxBindingStore(other).getCurrent(scope))?.resource).toMatchObject({
          allocationId: opened.resource.allocationId, handle: { runtimeId: "physical" }, useOutcome: "unknown", use: { attemptId: "old" },
        });
        expect(errors).toEqual([]);
      } finally { oldDone?.(); newDone?.(); await old.close(); await next.close(); await lifecycle.close(); }
    }));
  });
}

export async function clearIssue525Fixture(sql: SqlClient) {
  // Only called inside the test's disposable container / SQLite database.
  for (const table of ["managed_session_sandbox_resources", "managed_session_sandbox_bindings",
    "managed_session_executions", "managed_session_admission_counters", "managed_session_claim_locks"]) {
    await sql.prepare(`DELETE FROM ${table}`).run();
  }
}
