import { describe, expect, it, vi } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionSandboxBindingSchema, SqlSessionSandboxBindingStore } from "@open-managed-agents/session-runtime-sql/sandbox-binding";
import { NodeSessionSandboxLifecycle } from "../../../packages/control-plane-node/src/lib/node-session-sandbox-lifecycle";
import { NodeSessionSandboxLeaseWorker } from "../../../packages/control-plane-node/src/lib/node-session-sandbox-lease-worker";
import { ProcessInvariantError } from "../../../packages/control-plane-node/src/lib/process-invariant";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureSessionSandboxBindingSchema(sql);
  const store = new SqlSessionSandboxBindingStore(sql);
  let clock = 1_000_000;
  const now = () => new Date(clock);
  const lifecycle = new NodeSessionSandboxLifecycle({ store, provider: "test", ownerId: "resource-manager",
    allocationIsolation: true, runtimeBindingSupported: true, now });
  const scope = { workspaceId: "workspace", sessionId: "session" };
  const sandbox = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
  const opened = await lifecycle.open({ scope, configFingerprint: "test",
    create: async () => sandbox, resume: async () => sandbox,
    handle: () => ({ provider: "test", runtimeId: "physical" }), prepare: async () => {} });
  const renew = vi.fn(async () => {});
  const onError = vi.fn();
  const worker = (ownerId: string, callback = renew) => new NodeSessionSandboxLeaseWorker({
    sql, store, provider: "test", providerNamespace: "test", ownerId, ttlMs: 3000,
    renew: callback, onError, now,
  });
  await worker("setup").ensureSchema("sqlite");
  return { sql, store, lifecycle, scope, resource: opened.resource, renew, worker,
    advance: () => { clock += 1100; } };
}

describe("independent sandbox resource lease worker", () => {
  it("escalates shared invariants without releasing durable responsibility", async () => {
    const f = await fixture(); const processExit = vi.fn(); const onError = vi.fn();
    const worker = new NodeSessionSandboxLeaseWorker({ sql: f.sql, store: f.store, provider: "test",
      providerNamespace: "test", ownerId: "fatal-resource", ttlMs: 3000, now: () => new Date(1_000_000),
      renew: async () => { throw new ProcessInvariantError("resource coordination corrupted"); }, onError, processExit });
    await worker.poll(); expect(processExit).toHaveBeenCalledExactlyOnceWith(1); expect(onError).not.toHaveBeenCalled();
    expect(await f.sql.prepare("SELECT owner_id FROM managed_session_sandbox_lease_workers").first()).toEqual({ owner_id: "fatal-resource" });
    await worker.close();
  });

  it("renews without any attempt, survives worker replacement, and stops for a retired resource", async () => {
    const f = await fixture(); const first = f.worker("resource-a");
    await first.poll(); expect(f.renew).toHaveBeenCalledOnce(); await first.close();
    f.advance(); const replacement = f.worker("resource-b");
    await replacement.poll(); expect(f.renew).toHaveBeenCalledTimes(2);
    await f.lifecycle.closeSession(f.scope); f.advance();
    await replacement.poll(); expect(f.renew).toHaveBeenCalledTimes(2);
    expect((await f.store.find({ ...f.scope, allocationId: f.resource.allocationId }))?.desiredState).toBe("retired");
    await replacement.close();
  });

  it("does not couple renewal to an expired or uncertain execution use", async () => {
    const f = await fixture();
    await f.sql.prepare(`UPDATE managed_session_sandbox_resources SET use_execution_id = 'old',
      use_attempt_id = 'old', use_owner_id = 'old', use_generation = 1, use_outcome = 'unknown'`).run();
    const worker = f.worker("resource-worker"); await worker.poll();
    expect(f.renew).toHaveBeenCalledOnce();
    expect((await f.store.getCurrent(f.scope))?.resource).toMatchObject({ useOutcome: "unknown", use: { attemptId: "old" } });
    await worker.close();
  });

  it("fences delayed completion after resource-worker lease rotation", async () => {
    const f = await fixture(); const oldGate = deferred(); const newGate = deferred();
    const oldRenew = vi.fn(() => oldGate.promise); const newRenew = vi.fn(() => newGate.promise);
    const old = f.worker("old", oldRenew); const next = f.worker("new", newRenew);
    const oldPoll = old.poll(); await vi.waitFor(() => expect(oldRenew).toHaveBeenCalledOnce());
    await next.poll(); expect(newRenew).not.toHaveBeenCalled();
    f.advance(); const newPoll = next.poll(); await vi.waitFor(() => expect(newRenew).toHaveBeenCalledOnce());
    oldGate.resolve(); await oldPoll;
    expect(await f.sql.prepare("SELECT owner_id FROM managed_session_sandbox_lease_workers").first()).toEqual({ owner_id: "new" });
    newGate.resolve(); await newPoll; await old.close(); await next.close();
  });

  it("persists unavailable status and retries in the resource worker independently of input", async () => {
    const f = await fixture(); f.renew.mockRejectedValueOnce(new Error("provider unavailable"));
    const first = f.worker("first"); await first.poll();
    expect(await first.isAvailable(f.resource)).toBe(false); await first.close();
    f.advance(); const next = f.worker("next"); await next.poll();
    expect(await next.isAvailable(f.resource)).toBe(true); expect(f.renew).toHaveBeenCalledTimes(2);
    await next.close();
  });

  it("stops a hung local wait without clearing durable ownership or destroying the resource", async () => {
    const f = await fixture(); const pending = deferred(); const renew = vi.fn(() => pending.promise);
    const worker = f.worker("old", renew); const poll = worker.poll();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    await worker.close(); await poll;
    pending.resolve(); await Promise.resolve();
    expect(await f.sql.prepare("SELECT owner_id FROM managed_session_sandbox_lease_workers").first()).toEqual({ owner_id: "old" });
    expect((await f.store.getCurrent(f.scope))?.resource?.observedState).toBe("ready");
  });
});
