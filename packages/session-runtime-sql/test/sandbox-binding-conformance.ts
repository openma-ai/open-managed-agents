import { describe, expect, it } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type {
  SessionSandboxManagementFence,
  SessionSandboxMutationResult,
} from "@open-managed-agents/session-runtime-contract/sandbox-binding";
import { SqlSessionSandboxBindingStore } from "../src/sandbox-binding";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 5, 0, 0, seconds)).toISOString();

function updated(result: SessionSandboxMutationResult) {
  expect(result.type).toBe("updated");
  if (result.type !== "updated") throw new Error("Expected sandbox mutation to succeed");
  return result;
}

/** Shared behavioral suite: run against real SqlClient transactions, not a
 * storage-shaped Map. The fixture must install both binding and execution DDL. */
export function sessionSandboxBindingConformance(
  name: string,
  withClient: (run: (sql: SqlClient) => Promise<void>) => Promise<void>,
) {
  describe(`Session sandbox binding: ${name}`, () => {
    function fixture(sql: SqlClient) {
      const scope = { workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
      const store = new SqlSessionSandboxBindingStore(sql);
      const createInput = (allocationId = "allocation-a", expectedBindingRevision: number | null = null) => ({
        ...scope, allocationId, provider: "test-provider", providerNamespace: "test-provider:account-a",
        configFingerprint: "image-v1:mounts-v1", expectedBindingRevision,
        ownerId: "manager-a", now: at(0), leaseTtlMs: 30_000,
      });
      async function intent(allocationId = "allocation-a", revision: number | null = null) {
        const result = await store.createIntent(createInput(allocationId, revision));
        expect(result.type).toBe("created");
        if (result.type !== "created") throw new Error("Expected intent");
        return result;
      }
      async function ready() {
        const created = await intent();
        const allocated = updated(await store.recordHandle({
          fence: created.fence, expectedRevision: created.resource.revision, now: at(1),
          handle: { provider: "test-provider", runtimeId: "physical-a", metadata: { region: "local-a" } },
        }));
        return updated(await store.markReady({
          fence: created.fence, expectedRevision: allocated.resource.revision, now: at(2),
        }));
      }
      async function available() {
        const prepared = await ready();
        return updated(await store.releaseManagement({
          fence: prepared.fence!, expectedRevision: prepared.resource.revision, now: at(2),
        }));
      }
      async function execution(id = "execution-a", owner = "worker-a", expires = 10): Promise<SessionExecutionFence> {
        await sql.prepare(`INSERT INTO managed_session_executions (
          workspace_id, session_id, lane_id, id, admitted_at_ms, events_json, events_fingerprint,
          state, attempt_id, owner_id, generation, deadline_at_ms, lease_expires_at_ms, revision)
          VALUES (?, ?, 'primary', ?, ?, '[]', 'fingerprint', 'running', ?, ?, 1, ?, ?, 1)`)
          .bind(scope.workspaceId, scope.sessionId, id, Date.parse(at(0)), `attempt-${id}`, owner,
            Date.parse(at(100)), Date.parse(at(expires))).run();
        return { ...scope, executionId: id, attemptId: `attempt-${id}`, ownerId: owner, generation: 1, expiresAt: at(expires) };
      }
      return { scope, store, createInput, intent, ready, available, execution };
    }

    it("persists an unresolved create intent and its current pointer before any handle exists", () => withClient(async sql => {
      const f = fixture(sql);
      expect(await f.store.getCurrent(f.scope)).toBeNull();
      const created = await f.intent();
      const restarted = new SqlSessionSandboxBindingStore(sql);
      const roundTrip = JSON.parse(JSON.stringify(await restarted.getCurrent(f.scope)));
      expect(roundTrip).toMatchObject({
        binding: { allocationId: "allocation-a", revision: 1 },
        resource: {
          allocationId: "allocation-a", providerNamespace: "test-provider:account-a", handle: null,
          desiredState: "active", observedState: "intent", readiness: "none",
          management: { ownerId: "manager-a", generation: 1, leaseExpiresAt: at(30) },
          configFingerprint: "image-v1:mounts-v1", use: null,
        },
      });
      expect(await restarted.list(f.scope)).toEqual([created.resource]);
      expect(await restarted.find({ ...f.scope, allocationId: "allocation-a" })).toEqual(created.resource);
      expect(await restarted.find({ ...f.scope, workspaceId: "wrong-tenant", allocationId: "allocation-a" })).toBeNull();
    }));

    it("terminal Session retirement preserves unresolved use and fences late provisioning", () => withClient(async sql => {
      const f = fixture(sql); const ready = await f.available(); const fence = await f.execution();
      const use = updated(await f.store.claimUse({ fence, allocationId: "allocation-a", expectedRevision: ready.resource.revision, now: at(3) }));
      await f.store.closeSession({ ...f.scope, now: at(4) });
      const closed = await f.store.getCurrent(f.scope);
      expect(closed).toMatchObject({ binding: { closed: true, allocationId: null }, resource: null });
      expect(await f.store.find({ ...f.scope, allocationId: "allocation-a" })).toMatchObject({ desiredState: "retired", use: use.resource.use });
      expect(await f.store.createIntent(f.createInput("late-allocation", closed!.binding.revision))).toEqual({ type: "conflict" });
      expect(await f.store.listPending({ now: at(40) })).toEqual([]);
      const pending = (await f.store.find({ ...f.scope, allocationId: "allocation-a" }))!;
      updated(await f.store.releaseUse({ fence, allocationId: "allocation-a", expectedRevision: pending.revision, now: at(41) }));
      expect(await f.store.listPending({ now: at(42) })).toHaveLength(1);
    }));

    it("has one atomic winner when two replicas create or claim management", () => withClient(async sql => {
      const f = fixture(sql);
      const other = new SqlSessionSandboxBindingStore(sql);
      const creations = await Promise.all([
        f.store.createIntent(f.createInput("allocation-a")),
        other.createIntent(f.createInput("allocation-b")),
      ]);
      expect(creations.filter(result => result.type === "created")).toHaveLength(1);
      const created = creations.find(result => result.type === "created")!;
      if (created.type !== "created") throw new Error("Expected creation");
      expect(await f.store.list(f.scope)).toHaveLength(1);
      const claim = { ...f.scope, allocationId: created.resource.allocationId,
        expectedRevision: created.resource.revision, now: at(31), leaseTtlMs: 20_000 };
      const claims = await Promise.all([
        f.store.claimManagement({ ...claim, ownerId: "manager-b" }),
        other.claimManagement({ ...claim, ownerId: "manager-c" }),
      ]);
      expect(claims.filter(result => result.type === "claimed")).toHaveLength(1);
      const current = (await f.store.getCurrent(f.scope))!.resource!;
      expect(current.management.generation).toBe(2);
      expect(await f.store.recordHandle({
        fence: created.fence, expectedRevision: current.revision, now: at(32),
        handle: { provider: "test-provider", runtimeId: "late-create-response" },
      })).toEqual({ type: "conflict" });
      expect(current.handle).toBeNull();
    }));

    it("keeps management independent of readiness and rejects expired or superseded fences", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.ready();
      const released = updated(await f.store.releaseManagement({
        fence: ready.fence!, expectedRevision: ready.resource.revision, now: at(3),
      }));
      expect(released.resource).toMatchObject({ observedState: "ready", readiness: "prepared", management: { ownerId: null, generation: 1 } });
      expect(released.fence).toBeNull();
      const claimed = await f.store.claimManagement({
        ...f.scope, allocationId: "allocation-a", expectedRevision: released.resource.revision,
        ownerId: "manager-b", now: at(4), leaseTtlMs: 5_000,
      });
      if (claimed.type !== "claimed") throw new Error("Expected management handoff");
      expect(claimed.fence.generation).toBe(2);
      const revision = claimed.resource.revision;
      expect(await f.store.retire({ fence: ready.fence!, expectedRevision: revision, now: at(5) })).toEqual({ type: "conflict" });
      expect(await f.store.renewManagement({ fence: claimed.fence, now: at(9), leaseTtlMs: 10_000 })).toEqual({ type: "conflict" });
      expect((await f.store.getCurrent(f.scope))!.resource!.revision).toBe(revision);
    }));

    it("round-trips actual provider handles and forbids changing their physical identity", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.ready();
      const restarted = new SqlSessionSandboxBindingStore(sql);
      expect(JSON.parse(JSON.stringify((await restarted.getCurrent(f.scope))!.resource!.handle)))
        .toEqual({ provider: "test-provider", runtimeId: "physical-a", metadata: { region: "local-a" } });
      expect(await restarted.recordHandle({
        fence: ready.fence!, expectedRevision: ready.resource.revision, now: at(3),
        handle: { provider: "test-provider", runtimeId: "replacement-id" },
      })).toEqual({ type: "conflict" });
      expect(await restarted.recordHandle({
        fence: ready.fence!, expectedRevision: ready.resource.revision, now: at(3),
        handle: { provider: "wrong-provider", runtimeId: "physical-a" },
      })).toEqual({ type: "conflict" });
    }));

    it("retains failed cleanup and unresolved creates after replacement; old deletion cannot detach the new pointer", () => withClient(async sql => {
      const f = fixture(sql);
      const first = await f.ready();
      expect(await f.store.beginDelete({ fence: first.fence!, expectedRevision: first.resource.revision, now: at(3) })).toEqual({ type: "conflict" });
      const retired = updated(await f.store.retire({ fence: first.fence!, expectedRevision: first.resource.revision, now: at(3) }));
      expect(await f.store.getCurrent(f.scope)).toMatchObject({ binding: { allocationId: null, revision: 2 }, resource: null });
      const replacement = await f.intent("allocation-b", 2);
      const deleting = updated(await f.store.beginDelete({ fence: first.fence!, expectedRevision: retired.resource.revision, now: at(4) }));
      const failed = updated(await f.store.recordFailure({
        fence: first.fence!, expectedRevision: deleting.resource.revision, now: at(5),
        failure: "delete response lost", retryAt: at(20),
      }));
      const restarted = new SqlSessionSandboxBindingStore(sql);
      expect(await restarted.list(f.scope)).toMatchObject([
        { allocationId: "allocation-a", observedState: "deleting", failure: "delete response lost", retryAt: at(20) },
        { allocationId: "allocation-b", observedState: "intent", handle: null },
      ]);
      expect(await restarted.markReady({ fence: first.fence!, expectedRevision: failed.resource.revision, now: at(6) })).toEqual({ type: "conflict" });
      const retiredAgain = updated(await restarted.retire({ fence: first.fence!, expectedRevision: failed.resource.revision, now: at(6) }));
      expect((await restarted.getCurrent(f.scope))!.binding).toEqual(replacement.binding);
      const deleted = updated(await restarted.markDeleted({ fence: first.fence!, expectedRevision: retiredAgain.resource.revision, now: at(7) }));
      expect(deleted.resource.observedState).toBe("deleted");
      expect(await restarted.list(f.scope)).toEqual([replacement.resource]);
      expect(await restarted.list({ ...f.scope, includeDeleted: true })).toHaveLength(2);
      expect((await restarted.getCurrent(f.scope))!.binding).toEqual(replacement.binding);
      expect(await restarted.recordHandle({ fence: replacement.fence, expectedRevision: 1, now: at(8),
        handle: { provider: "test-provider", runtimeId: "physical-a" } })).toEqual({ type: "conflict" });
    }));

    it("can recover the real handle of a retired unknown-create intent without reviving it", () => withClient(async sql => {
      const f = fixture(sql);
      const first = await f.intent();
      const retired = updated(await f.store.retire({ fence: first.fence, expectedRevision: 1, now: at(1) }));
      await f.intent("allocation-b", 2);
      const recovered = updated(await f.store.recordHandle({
        fence: first.fence, expectedRevision: retired.resource.revision, now: at(2),
        handle: { provider: "test-provider", runtimeId: "found-by-allocation-id" },
      }));
      expect(recovered.resource).toMatchObject({ desiredState: "retired", handle: { runtimeId: "found-by-allocation-id" } });
      expect((await f.store.getCurrent(f.scope))!.resource!.allocationId).toBe("allocation-b");
      expect(await f.store.markReady({ fence: first.fence, expectedRevision: recovered.resource.revision, now: at(3) })).toEqual({ type: "conflict" });
    }));

    it("treats identical provider runtime IDs in distinct configuration namespaces independently", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.ready();
      const created = await f.store.createIntent({ ...f.createInput("allocation-b"), sessionId: "different-session", providerNamespace: "test-provider:account-b" });
      if (created.type !== "created") throw new Error("Expected second namespace");
      updated(await f.store.recordHandle({ fence: created.fence, expectedRevision: 1, now: at(3), handle: ready.resource.handle! }));
      expect((await f.store.list({ ...f.scope, sessionId: "different-session" }))[0].handle).toEqual(ready.resource.handle);
    }));

    it("requires canonical execution authority in addition to current ready resource state", () => withClient(async sql => {
      const f = fixture(sql);
      const first = await f.intent();
      const fence = await f.execution("execution-a", "worker-a", 60);
      const input = { fence, allocationId: first.resource.allocationId, expectedRevision: 1, now: at(1) };
      expect(await f.store.claimUse(input)).toEqual({ type: "conflict" });
      const allocated = updated(await f.store.recordHandle({ fence: first.fence, expectedRevision: 1, now: at(1), handle: { provider: "test-provider", runtimeId: "physical-a" } }));
      const prepared = updated(await f.store.markReady({ fence: first.fence, expectedRevision: allocated.resource.revision, now: at(2) }));
      expect(await f.store.claimUse({ ...input, expectedRevision: prepared.resource.revision, now: at(3) })).toEqual({ type: "conflict" });
      // An expired manager can still have unresolved prepare operations.
      expect(await f.store.claimUse({ ...input, expectedRevision: prepared.resource.revision, now: at(31) })).toEqual({ type: "conflict" });
      const ready = updated(await f.store.releaseManagement({ fence: first.fence, expectedRevision: prepared.resource.revision, now: at(2) }));
      const usable = { ...input, expectedRevision: ready.resource.revision, now: at(3) };
      for (const invalid of [
        { ...fence, attemptId: "wrong-attempt" }, { ...fence, ownerId: "wrong-owner" },
        { ...fence, generation: 2 }, { ...fence, executionId: "missing" },
        { ...fence, workspaceId: "wrong-workspace" }, { ...fence, sessionId: "wrong-session" },
      ]) expect(await f.store.claimUse({ ...usable, fence: invalid })).toEqual({ type: "conflict" });
      expect(await f.store.claimUse({ ...usable, now: at(60) })).toEqual({ type: "conflict" });
      const claimed = updated(await f.store.claimUse(usable));
      expect(claimed.resource.use).toEqual({ executionId: fence.executionId, attemptId: fence.attemptId, ownerId: fence.ownerId, generation: 1 });
      expect(claimed.resource.management).toEqual(ready.resource.management);
      expect(claimed.resource.useOutcome).toBe("active");
      await sql.prepare("UPDATE managed_session_executions SET state = 'completed' WHERE workspace_id = ? AND id = ?")
        .bind(f.scope.workspaceId, fence.executionId).run();
      expect(await f.store.claimUse({ ...usable, expectedRevision: claimed.resource.revision })).toEqual({ type: "conflict" });
    }));

    it("does not reclaim a use on attempt expiry, unknown outcome, or process cache loss", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.available();
      const a = await f.execution();
      const b = await f.execution("execution-b", "worker-b", 60);
      const claimed = updated(await f.store.claimUse({ fence: a, allocationId: "allocation-a", expectedRevision: ready.resource.revision, now: at(3) }));
      const restarted = new SqlSessionSandboxBindingStore(sql);
      expect(await restarted.claimUse({ fence: b, allocationId: "allocation-a", expectedRevision: claimed.resource.revision, now: at(11) })).toEqual({ type: "conflict" });
      expect(await restarted.claimManagement({ ...f.scope, allocationId: "allocation-a", expectedRevision: claimed.resource.revision,
        ownerId: "cleanup", now: at(31), leaseTtlMs: 30_000 })).toEqual({ type: "conflict" });
      const unknown = updated(await restarted.markUseUnknown({ fence: a, allocationId: "allocation-a", expectedRevision: claimed.resource.revision, now: at(11) }));
      expect(unknown.resource).toMatchObject({ use: { executionId: a.executionId }, useOutcome: "unknown" });
      expect(await restarted.claimUse({ fence: b, allocationId: "allocation-a", expectedRevision: unknown.resource.revision, now: at(12) })).toEqual({ type: "conflict" });
      // An execution renewal cannot turn an unknown provider effect into a safe reuse.
      await sql.prepare("UPDATE managed_session_executions SET lease_expires_at_ms = ? WHERE workspace_id = ? AND id = ?")
        .bind(Date.parse(at(50)), f.scope.workspaceId, a.executionId).run();
      expect(await restarted.claimUse({ fence: a, allocationId: "allocation-a", expectedRevision: unknown.resource.revision, now: at(12) })).toEqual({ type: "conflict" });
      const released = updated(await restarted.releaseUse({ fence: a, allocationId: "allocation-a", expectedRevision: unknown.resource.revision, now: at(13) }));
      const claimedB = updated(await restarted.claimUse({ fence: b, allocationId: "allocation-a", expectedRevision: released.resource.revision, now: at(14) }));
      // Even with a fresh resource revision, A cannot release or quarantine B.
      expect(await restarted.releaseUse({ fence: a, allocationId: "allocation-a", expectedRevision: claimedB.resource.revision, now: at(15) })).toEqual({ type: "conflict" });
      expect(await restarted.markUseUnknown({ fence: a, allocationId: "allocation-a", expectedRevision: claimedB.resource.revision, now: at(15) })).toEqual({ type: "conflict" });
      expect((await restarted.getCurrent(f.scope))!.resource!.use!.executionId).toBe(b.executionId);
    }));

    it("serializes use acquisition against exclusive management and gives only one replica the revision", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.available();
      const execution = await f.execution();
      const replica = new SqlSessionSandboxBindingStore(sql);
      const results = await Promise.all([
        f.store.claimUse({ fence: execution, allocationId: "allocation-a", expectedRevision: ready.resource.revision, now: at(3) }),
        replica.claimManagement({ ...f.scope, allocationId: "allocation-a", expectedRevision: ready.resource.revision,
          ownerId: "manager-b", now: at(3), leaseTtlMs: 30_000 }),
      ]);
      expect(results.filter(result => result.type !== "conflict")).toHaveLength(1);
      const current = await f.store.getCurrent(f.scope);
      if (results[0].type === "updated") {
        expect(current!.resource!.use!.executionId).toBe(execution.executionId);
        expect(current!.resource!.desiredState).toBe("active");
      } else {
        expect(current!.resource!.management.ownerId).toBe("manager-b");
        expect(current!.resource!.use).toBeNull();
        const claimed = results[1];
        if (claimed.type !== "claimed") throw new Error("Expected manager");
        updated(await replica.retire({ fence: claimed.fence, expectedRevision: claimed.resource.revision, now: at(4) }));
        expect((await replica.getCurrent(f.scope))!.resource).toBeNull();
      }
    }));

    it("rolls back resource retirement and pointer detachment together on transaction failure", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.ready();
      // Duplicate an existing primary key at the end: preparation succeeds,
      // execution fails after the real mutations, exercising actual rollback.
      const broken: SqlClient = {
        prepare: text => sql.prepare(text), exec: text => sql.exec(text),
        batch: statements => sql.batch([
          ...statements,
          sql.prepare("INSERT INTO managed_session_sandbox_bindings (workspace_id, session_id) VALUES (?, ?)")
            .bind(f.scope.workspaceId, f.scope.sessionId),
        ]),
      };
      await expect(new SqlSessionSandboxBindingStore(broken).retire({ fence: ready.fence!, expectedRevision: ready.resource.revision, now: at(3) })).rejects.toBeDefined();
      expect((await f.store.getCurrent(f.scope))!.resource).toEqual(ready.resource);
    }));

    it("checks canonical lease changes at the commit boundary instead of a prior read", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.available();
      const fence = await f.execution();
      const changed: SqlClient = {
        prepare: text => sql.prepare(text), exec: text => sql.exec(text),
        batch: async statements => {
          await sql.prepare("UPDATE managed_session_executions SET generation = generation + 1 WHERE workspace_id = ? AND id = ?")
            .bind(f.scope.workspaceId, fence.executionId).run();
          return sql.batch(statements);
        },
      };
      expect(await new SqlSessionSandboxBindingStore(changed).claimUse({
        fence, allocationId: "allocation-a", expectedRevision: ready.resource.revision, now: at(3),
      })).toEqual({ type: "conflict" });
      expect((await f.store.getCurrent(f.scope))!.resource!.use).toBeNull();
    }));

    it("cannot turn a management fence into use authority or revive a lost incarnation", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.ready();
      const lost = updated(await f.store.recordFailure({
        fence: ready.fence!, expectedRevision: ready.resource.revision, now: at(3), failure: "provider reports missing", lost: true,
      }));
      expect(lost.resource).toMatchObject({ observedState: "lost", readiness: "none" });
      const fence = await f.execution();
      expect(await f.store.claimUse({ fence, allocationId: "allocation-a", expectedRevision: lost.resource.revision, now: at(4) })).toEqual({ type: "conflict" });
      expect(await f.store.markReady({ fence: ready.fence!, expectedRevision: lost.resource.revision, now: at(4) })).toEqual({ type: "conflict" });
      // A forged management generation cannot write even using the fresh revision.
      const fake: SessionSandboxManagementFence = { ...ready.fence!, generation: 42 };
      expect(await f.store.retire({ fence: fake, expectedRevision: lost.resource.revision, now: at(4) })).toEqual({ type: "conflict" });
    }));

    it("discovers due cleanup and unresolved intents after restart without scanning active ready resources", () => withClient(async sql => {
      const f = fixture(sql);
      const first = await f.ready();
      expect(await f.store.listPending({ now: at(31), workspaceId: f.scope.workspaceId })).toEqual([]);
      const retired = updated(await f.store.retire({ fence: first.fence!, expectedRevision: first.resource.revision, now: at(3) }));
      const failed = updated(await f.store.recordFailure({ fence: first.fence!, expectedRevision: retired.resource.revision,
        now: at(4), failure: "provider delete unavailable", retryAt: at(20) }));
      updated(await f.store.releaseManagement({ fence: first.fence!, expectedRevision: failed.resource.revision, now: at(5) }));
      const replacement = await f.intent("allocation-b", 2);
      const restarted = new SqlSessionSandboxBindingStore(sql);
      expect(await restarted.listPending({ now: at(19), workspaceId: f.scope.workspaceId })).toEqual([]);
      expect(await restarted.listPending({ now: at(20), workspaceId: f.scope.workspaceId })).toMatchObject([
        { allocationId: "allocation-a", desiredState: "retired", retryAt: at(20) },
      ]);
      const pending = await restarted.listPending({ now: at(31), workspaceId: f.scope.workspaceId });
      expect(pending.map(resource => resource.allocationId)).toEqual(["allocation-b", "allocation-a"]);
      expect(pending[0].handle).toBeNull();
      expect(await restarted.listPending({ now: at(31), workspaceId: "different-workspace" })).toEqual([]);
      expect(await restarted.listPending({ now: at(31), workspaceId: f.scope.workspaceId, limit: 1 })).toHaveLength(1);
      expect(await restarted.listPending({ now: at(31), workspaceId: f.scope.workspaceId, limit: 1,
        purpose: "delete", provider: "test-provider", providerNamespace: "test-provider:account-a" }))
        .toMatchObject([{ allocationId: "allocation-a", desiredState: "retired" }]);
      expect(await restarted.listPending({ now: at(31), purpose: "delete", providerNamespace: "another-account" })).toEqual([]);
      expect(await restarted.listPending({ now: at(31), purpose: "delete", provider: "another-provider" })).toEqual([]);
      // Discovery is not authority: the intent's old owner is expired.
      expect(await restarted.recordHandle({ fence: replacement.fence, expectedRevision: 1, now: at(31),
        handle: { provider: "test-provider", runtimeId: "too-late" } })).toEqual({ type: "conflict" });
      await expect(restarted.listPending({ now: at(31), limit: 0 })).rejects.toThrow("scan limit");
    }));

    it("refuses retirement and deletion while an exact-use drain is still unresolved", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.ready();
      // A persisted conflicting holder can exist during an upgrade or recovery;
      // the mutation gate must enforce exclusion, not rely on an earlier read.
      await sql.prepare(`UPDATE managed_session_sandbox_resources SET use_execution_id = 'old-execution',
        use_attempt_id = 'old-attempt', use_owner_id = 'old-worker', use_generation = 1, use_outcome = 'unknown'
        WHERE workspace_id = ? AND session_id = ? AND allocation_id = ?`)
        .bind(f.scope.workspaceId, f.scope.sessionId, "allocation-a").run();
      const mutation = { fence: ready.fence!, expectedRevision: ready.resource.revision, now: at(3) };
      expect(await f.store.retire(mutation)).toEqual({ type: "conflict" });
      await sql.prepare("UPDATE managed_session_sandbox_resources SET desired_state = 'retired', observed_state = 'deleting' WHERE workspace_id = ? AND session_id = ?")
        .bind(f.scope.workspaceId, f.scope.sessionId).run();
      await sql.prepare("UPDATE managed_session_sandbox_bindings SET allocation_id = NULL WHERE workspace_id = ? AND session_id = ?")
        .bind(f.scope.workspaceId, f.scope.sessionId).run();
      expect(await f.store.beginDelete(mutation)).toEqual({ type: "conflict" });
      expect(await f.store.markDeleted(mutation)).toEqual({ type: "conflict" });
      expect(await f.store.listPending({ now: at(40), workspaceId: f.scope.workspaceId })).toEqual([]);
    }));

    it("does not lend a ready resource carrying an unresolved preparation failure after management release", () => withClient(async sql => {
      const f = fixture(sql);
      const ready = await f.ready();
      const failed = updated(await f.store.recordFailure({ fence: ready.fence!, expectedRevision: ready.resource.revision,
        now: at(3), failure: "rebind_in_progress" }));
      const released = updated(await f.store.releaseManagement({ fence: ready.fence!, expectedRevision: failed.resource.revision, now: at(4) }));
      expect(released.resource).toMatchObject({ observedState: "ready", management: { ownerId: null } });
      const fence = await f.execution();
      expect(await f.store.claimUse({ fence, allocationId: "allocation-a", expectedRevision: released.resource.revision, now: at(5) })).toEqual({ type: "conflict" });
    }));
  });
}
