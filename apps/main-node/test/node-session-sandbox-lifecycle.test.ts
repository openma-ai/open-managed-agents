import { afterEach, describe, expect, it, vi } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { SessionSandboxHandle } from "@open-managed-agents/session-runtime-contract/sandbox-binding";
import { ensureSessionExecutionCoordinatorSchema } from "@open-managed-agents/session-runtime-sql/coordination";
import { ensureSessionSandboxBindingSchema, SqlSessionSandboxBindingStore } from "@open-managed-agents/session-runtime-sql/sandbox-binding";
import {
  NodeSessionSandboxLifecycle,
  type NodeSessionSandboxLifecycleOptions,
  type OpenNodeSessionSandbox,
} from "../../../packages/control-plane-node/src/lib/node-session-sandbox-lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(overrides: Partial<NodeSessionSandboxLifecycleOptions> = {}) {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureSessionExecutionCoordinatorSchema(sql);
  await ensureSessionSandboxBindingSchema(sql);
  const scope = { workspaceId: "workspace", sessionId: "session" };
  const store = new SqlSessionSandboxBindingStore(sql);
  const physical = new Map<string, Map<string, string>>();
  const handles = new WeakMap<SandboxExecutor, SessionSandboxHandle>();
  const destroyed: string[] = [];
  let sequence = 0;
  let now = new Date("2026-11-05T00:00:00.000Z");
  const clock = overrides.now ?? (() => now);
  function client(id: string): SandboxExecutor {
    const files = physical.get(id);
    if (!files) throw new Error("provider resource missing");
    const sandbox = {
      exec: async () => "",
      writeFile: async (path: string, value: string) => { files.set(path, value); return path; },
      readFile: async (path: string) => files.get(path) ?? "",
      destroy: vi.fn(async () => { destroyed.push(id); physical.delete(id); }),
    } as unknown as SandboxExecutor;
    handles.set(sandbox, { provider: "test", runtimeId: id });
    return sandbox;
  }
  const create = vi.fn(async (allocationId: string) => {
    const durable = (await store.getCurrent(scope))!.resource!;
    expect(durable).toMatchObject({ allocationId, observedState: "intent", handle: null });
    const id = `physical-${allocationId}`;
    physical.set(id, new Map());
    return client(id);
  });
  const resume = vi.fn(async (handle: SessionSandboxHandle) => client(handle.runtimeId));
  const handle = (sandbox: SandboxExecutor) => handles.get(sandbox)!;
  const prepare = vi.fn<OpenNodeSessionSandbox["prepare"]>(async (sandbox, allocationId, signal, authorization) => {
    signal.throwIfAborted();
    expect(await authorization.isCurrent()).toBe(true);
    expect(authorization.fence.allocationId).toBe(allocationId);
    const durable = (await store.getCurrent(scope))!.resource!;
    expect(durable.handle).toEqual(handle(sandbox));
    if (authorization.fresh) await sandbox.writeFile("file", "initial");
  });
  function service(ownerId = "manager-a", more: Partial<NodeSessionSandboxLifecycleOptions> = {}) {
    return new NodeSessionSandboxLifecycle({
      store, provider: "test", ownerId, allocationIsolation: true, runtimeBindingSupported: true,
      now: clock, id: () => `allocation-${++sequence}`, pollIntervalMs: 1,
      reaper: { resume: resource => resume(resource.handle!), handle },
      ...overrides, ...more,
    });
  }
  const input = { scope, configFingerprint: "config-v1", create, resume, handle, prepare };
  async function execution(owner = "worker-a", generation = 1): Promise<SessionExecutionFence> {
    const expiresAt = new Date(clock().getTime() + 1_000).toISOString();
    await sql.prepare(`INSERT INTO managed_session_executions (
      workspace_id, session_id, lane_id, id, admitted_at_ms, events_json, events_fingerprint,
      state, attempt_id, owner_id, generation, deadline_at_ms, lease_expires_at_ms, revision)
      VALUES (?, ?, 'primary', 'execution', ?, '[]', 'fingerprint', 'running', ?, ?, ?, ?, ?, 1)
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        attempt_id = excluded.attempt_id, owner_id = excluded.owner_id,
        generation = excluded.generation, lease_expires_at_ms = excluded.lease_expires_at_ms`)
      .bind(scope.workspaceId, scope.sessionId, clock().getTime(), `attempt-${generation}`, owner,
        generation, clock().getTime() + 60_000, Date.parse(expiresAt)).run();
    return { ...scope, executionId: "execution", attemptId: `attempt-${generation}`, ownerId: owner, generation, expiresAt };
  }
  return { sql, scope, store, physical, destroyed, client, input, service, execution, setTime: (value: Date) => { now = value; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Node Session sandbox lifecycle", () => {
  it("renews by durable handle after restart, without resolving a client or changing use ownership", async () => {
    const renewal = vi.fn(async () => undefined);
    const f = await fixture({ renewProviderLease: renewal });
    const first = f.service();
    const opened = await first.open(f.input);
    const fence = await f.execution();
    await first.borrow({ executionFence: fence, allocationId: opened.allocationId });
    const before = (await f.store.getCurrent(f.scope))!.resource!;
    const signal = new AbortController().signal;
    await first.renewProviderLease(before, 60000, signal);
    await first.close();
    await f.service("new-manager").renewProviderLease(before, 60000, signal);
    expect(renewal).toHaveBeenCalledTimes(2);
    expect(renewal.mock.calls[0]).toEqual(renewal.mock.calls[1]);
    expect(f.input.create).toHaveBeenCalledOnce();
    expect(f.input.resume).not.toHaveBeenCalled();
    expect((await f.store.getCurrent(f.scope))!.resource).toEqual(before);
  });

  it("does not fall back to resume when handle renewal fails", async () => {
    const failure = new Error("provider response unknown");
    const f = await fixture({ renewProviderLease: async () => { throw failure; } });
    const service = f.service(); const opened = await service.open(f.input);
    await expect(service.renewProviderLease(opened.resource, 60000, new AbortController().signal)).rejects.toBe(failure);
    expect(f.input.resume).not.toHaveBeenCalled();
    expect(f.input.create).toHaveBeenCalledOnce();
  });

  it("persists intent and physical handle before preparation, then rebinds after all client caches are lost", async () => {
    const f = await fixture();
    const original = f.service();
    const first = await original.open(f.input);
    expect(first.resource).toMatchObject({ observedState: "ready", readiness: "prepared", management: { ownerId: null } });
    await first.sandbox.writeFile("file", "Session edit");
    await original.close();
    const second = await f.service("restarted-manager").open(f.input);
    expect(second.allocationId).toBe(first.allocationId);
    expect(second.sandbox).not.toBe(first.sandbox);
    expect(await second.sandbox.readFile("file")).toBe("Session edit");
    expect(f.input.create).toHaveBeenCalledTimes(1);
    expect(f.input.resume).toHaveBeenCalledTimes(1);
    expect(f.input.prepare.mock.calls.map(call => call[3].fresh)).toEqual([true, false]);
    expect(f.destroyed).toEqual([]);
  });

  it("coalesces local waiters and lets another replica wait for persisted readiness", async () => {
    const f = await fixture();
    const started = deferred();
    const finish = deferred();
    const manager = f.service();
    const input = { ...f.input, prepare: vi.fn<OpenNodeSessionSandbox["prepare"]>(async (...args) => {
      started.resolve(); await finish.promise; await f.input.prepare(...args);
    }) };
    const first = manager.open(input);
    await started.promise;
    const coalesced = manager.open(input);
    const other = f.service("replica").open(f.input);
    finish.resolve();
    const results = await Promise.all([first, coalesced, other]);
    expect(new Set(results.map(result => result.allocationId)).size).toBe(1);
    expect(f.input.create).toHaveBeenCalledTimes(1);
  });

  it("continues Session provisioning and management renewal after its caller stops waiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    const f = await fixture({ now: () => new Date(), leaseTtlMs: 120, renewIntervalMs: 30 });
    const started = deferred();
    const finish = deferred();
    let preparationSignal!: AbortSignal;
    let managementExpiry = "";
    const controller = new AbortController();
    const promise = f.service().open({ ...f.input, waitSignal: controller.signal, prepare: async (...args) => {
      preparationSignal = args[2]; managementExpiry = args[3].fence.expiresAt;
      started.resolve(); await finish.promise;
      expect(Date.parse(args[3].fence.expiresAt)).toBeGreaterThan(Date.parse(managementExpiry));
      await f.input.prepare(...args);
    } });
    await started.promise;
    const rejected = expect(promise).rejects.toThrow("caller stopped");
    controller.abort(new Error("caller stopped"));
    await rejected;
    await vi.advanceTimersByTimeAsync(300);
    expect(preparationSignal.aborted).toBe(false);
    expect((await f.store.getCurrent(f.scope))!.resource!.management.ownerId).toBe("manager-a");
    finish.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.store.getCurrent(f.scope))!.resource).toMatchObject({ observedState: "ready", management: { ownerId: null } });
  });

  it("never retries an unknown create result, including after manager restart", async () => {
    const f = await fixture();
    const create = vi.fn(async () => { throw new Error("provider response lost"); });
    await expect(f.service().open({ ...f.input, create })).rejects.toThrow("provider response lost");
    await expect(f.service("restarted").open({ ...f.input, create })).rejects.toMatchObject({ code: "unknown_create", message: expect.stringContaining("provider response lost") });
    expect(create).toHaveBeenCalledTimes(1);
    expect((await f.store.getCurrent(f.scope))!.resource).toMatchObject({ observedState: "intent", handle: null });
    const resource = (await f.store.getCurrent(f.scope))!.resource!;
    await expect(f.service().retire({ ...f.scope, allocationId: resource.allocationId })).rejects.toMatchObject({ code: "unknown_create" });
    // Even a pre-existing detached intent in inventory cannot be bypassed.
    const claim = await f.store.claimManagement({ ...resource, expectedRevision: resource.revision,
      ownerId: "external-reconciler", now: "2026-11-05T00:00:00Z", leaseTtlMs: 30_000 });
    if (claim.type !== "claimed") throw new Error("claim");
    await f.store.retire({ fence: claim.fence, expectedRevision: claim.resource.revision, now: "2026-11-05T00:00:00Z" });
    await expect(f.service("after-detach").open({ ...f.input, create })).rejects.toMatchObject({ code: "unknown_create", message: expect.stringContaining("provider response lost") });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not publish readiness from a late preparation callback after management renewal fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    const f = await fixture({ now: () => new Date(), leaseTtlMs: 120, renewIntervalMs: 30 });
    const started = deferred();
    const finish = deferred();
    let checkCurrent!: () => Promise<boolean>;
    const promise = f.service().open({ ...f.input, prepare: async (_sandbox, _allocation, _signal, auth) => {
      checkCurrent = auth.isCurrent;
      started.resolve(); await finish.promise; // Simulate a provider ignoring cancellation.
    } });
    await started.promise;
    vi.spyOn(f.store, "renewManagement").mockRejectedValueOnce(new Error("database temporarily unavailable"));
    const rejected = expect(promise).rejects.toMatchObject({ code: "management_lost" });
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(await checkCurrent()).toBe(false);
    finish.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect((await f.store.getCurrent(f.scope))!.resource!.observedState).toBe("allocated");
    await expect(f.service("restarted").open(f.input)).rejects.toMatchObject({ code: "unknown_management" });
    expect(f.input.create).toHaveBeenCalledTimes(1);
  });

  it.each(["allocated", "ready"])("does not resume %s resources left by expired management", async observed => {
    const f = await fixture();
    const intent = await f.store.createIntent({
      ...f.scope, allocationId: "abandoned", provider: "test", configFingerprint: "config-v1",
      expectedBindingRevision: null, ownerId: "old-manager", now: "2026-11-05T00:00:00Z", leaseTtlMs: 1_000,
    });
    if (intent.type !== "created") throw new Error("intent");
    let changed = await f.store.recordHandle({ fence: intent.fence, expectedRevision: intent.resource.revision,
      now: "2026-11-05T00:00:00Z", handle: { provider: "test", runtimeId: "old-resource" } });
    if (changed.type !== "updated") throw new Error("handle");
    if (observed === "ready") {
      changed = await f.store.markReady({ fence: intent.fence, expectedRevision: changed.resource.revision, now: "2026-11-05T00:00:00Z" });
      if (changed.type !== "updated") throw new Error("ready");
      await f.store.recordFailure({ fence: intent.fence, expectedRevision: changed.resource.revision,
        now: "2026-11-05T00:00:00Z", failure: "rebind_in_progress" });
    }
    f.setTime(new Date("2026-11-05T00:00:02Z"));
    await expect(f.service("replacement-manager").open(f.input)).rejects.toMatchObject({ code: "unknown_management" });
    expect(f.input.create).not.toHaveBeenCalled();
    expect(f.input.resume).not.toHaveBeenCalled();
    expect((await f.store.getCurrent(f.scope))!.resource!.failure).toEqual(
      observed === "ready" ? "rebind_in_progress" : expect.stringContaining("reconciliation"));
  });

  it("blocks takeover and retirement after execution expiry or an uncertain operation, and rejects a late release", async () => {
    const f = await fixture();
    const manager = f.service();
    const opened = await manager.open(f.input);
    const first = await f.execution();
    await manager.borrow({ executionFence: first, allocationId: opened.allocationId });
    f.setTime(new Date("2026-11-05T00:00:02Z"));
    await expect(f.service("replacement").open(f.input)).rejects.toMatchObject({ code: "use_conflict" });
    await manager.release({ executionFence: first, allocationId: opened.allocationId, unknown: true });
    await expect(manager.borrow({ executionFence: first, allocationId: opened.allocationId })).rejects.toMatchObject({ code: "use_conflict" });
    await expect(manager.retire({ ...f.scope, allocationId: opened.allocationId })).rejects.toMatchObject({ code: "use_conflict" });
    // Explicit confirmation of draining is different from lease expiry.
    await manager.release({ executionFence: first, allocationId: opened.allocationId, unknown: false });
    const second = await f.execution("worker-b", 2);
    await manager.borrow({ executionFence: second, allocationId: opened.allocationId });
    await expect(manager.release({ executionFence: first, allocationId: opened.allocationId, unknown: false })).rejects.toMatchObject({ code: "use_conflict" });
    expect((await f.store.getCurrent(f.scope))!.resource!.use?.ownerId).toBe("worker-b");
  });

  it("retries a use-release CAS conflict without clearing a different identity", async () => {
    const f = await fixture();
    const manager = f.service();
    const opened = await manager.open(f.input);
    const fence = await f.execution();
    await manager.borrow({ executionFence: fence, allocationId: opened.allocationId });
    const release = vi.spyOn(f.store, "releaseUse").mockResolvedValueOnce({ type: "conflict" });
    const released = await manager.release({ executionFence: fence, allocationId: opened.allocationId, unknown: false });
    expect(released.use).toBeNull();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("requires a live canonical execution lease to borrow", async () => {
    const f = await fixture();
    const manager = f.service();
    const opened = await manager.open(f.input);
    const fence = await f.execution();
    f.setTime(new Date("2026-11-05T00:00:02Z"));
    await expect(manager.borrow({ executionFence: fence, allocationId: opened.allocationId })).rejects.toMatchObject({ code: "use_conflict" });
    expect((await f.store.getCurrent(f.scope))!.resource!.use).toBeNull();
  });

  it("serializes Session file operations against execution use and reopens clients after restart", async () => {
    const f = await fixture();
    const manager = f.service();
    const opened = await manager.open(f.input);
    const fence = await f.execution();
    await manager.borrow({ executionFence: fence, allocationId: opened.allocationId });
    const write = vi.fn(async (sandbox: SandboxExecutor) => sandbox.writeFile("file", "API update"));
    const input = { scope: f.scope, allocationId: opened.allocationId };
    await expect(manager.operate(input, write)).rejects.toMatchObject({ code: "use_conflict" });
    expect(write).not.toHaveBeenCalled();
    await manager.release({ executionFence: fence, allocationId: opened.allocationId, unknown: false });
    await manager.close();
    const restarted = f.service("file-manager", { reaper: { resume: resource => f.input.resume(resource.handle!), handle: f.input.handle } });
    await restarted.operate(input, async (sandbox, signal) => {
      expect(signal.aborted).toBe(false);
      const current = (await f.store.getCurrent(f.scope))!.resource!;
      expect(current.failure).toContain("operation_in_progress");
      await expect(restarted.borrow({ executionFence: fence, allocationId: opened.allocationId })).rejects.toMatchObject({ code: "not_ready" });
      return write(sandbox);
    });
    expect(await restarted.operate(input, sandbox => sandbox.readFile("file"))).toBe("API update");
    await restarted.borrow({ executionFence: fence, allocationId: opened.allocationId });
  });

  it("preserves an uncertain Session file operation failure and refuses a later borrow", async () => {
    const f = await fixture();
    const manager = f.service();
    const opened = await manager.open(f.input);
    await expect(manager.operate({ scope: f.scope, allocationId: opened.allocationId }, async sandbox => {
      await sandbox.writeFile("file", "possibly partial");
      throw new Error("lost response after remote effect");
    })).rejects.toThrow("lost response after remote effect");
    const current = (await f.store.getCurrent(f.scope))!.resource!;
    expect(current).toMatchObject({ observedState: "lost", readiness: "none", management: { ownerId: null } });
    expect(current.failure).toContain("requires reconciliation");
    await expect(manager.borrow({ executionFence: await f.execution(), allocationId: opened.allocationId })).rejects.toMatchObject({ code: "not_ready" });
  });

  it("reaps only retired allocations after restart and leaves the new current resource untouched", async () => {
    const f = await fixture();
    const manager = f.service();
    const first = await manager.open(f.input);
    await manager.retire({ ...f.scope, allocationId: first.allocationId });
    const current = await manager.open(f.input);
    expect(current.allocationId).not.toBe(first.allocationId);
    await manager.close();
    const reaper = f.service("reaper", { reaper: { resume: (resource) => f.input.resume(resource.handle!), handle: f.input.handle } });
    expect(await reaper.reconcile()).toEqual([{ allocationId: first.allocationId, deleted: true }]);
    expect(f.destroyed).toEqual([first.resource.handle!.runtimeId]);
    expect((await f.store.getCurrent(f.scope))!.resource!.allocationId).toBe(current.allocationId);
    expect(await current.sandbox.readFile("file")).toBe("initial");
  });

  it("keeps failed and unsupported deletion discoverable until a later confirmed delete", async () => {
    const f = await fixture();
    const manager = f.service();
    const first = await manager.open(f.input);
    await manager.retire({ ...f.scope, allocationId: first.allocationId });
    const noDestroy = f.client(first.resource.handle!.runtimeId);
    delete noDestroy.destroy;
    await expect(manager.reap({ ...f.scope, allocationId: first.allocationId, resume: async () => noDestroy })).rejects.toMatchObject({ code: "cleanup_unavailable" });
    expect((await f.store.find({ ...f.scope, allocationId: first.allocationId }))!.observedState).toBe("deleting");
    const failed = f.client(first.resource.handle!.runtimeId);
    failed.destroy = async () => { throw new Error("delete response unknown"); };
    await expect(manager.reap({ ...f.scope, allocationId: first.allocationId, resume: async () => failed })).rejects.toThrow("delete response unknown");
    f.setTime(new Date("2026-11-05T00:01:00Z"));
    const reaper = f.service("restarted-reaper", { reaper: { resume: resource => f.input.resume(resource.handle!) } });
    expect(await reaper.reconcile()).toEqual([{ allocationId: first.allocationId, deleted: true }]);
  });

  it("filters unknown intents and other provider namespaces before a one-item cleanup limit", async () => {
    const f = await fixture();
    // These older rows used to consume the whole listPending limit even
    // though this lifecycle could not act on either of them.
    await f.store.createIntent({ ...f.scope, sessionId: "old-intent", allocationId: "unknown",
      provider: "test", configFingerprint: "config", expectedBindingRevision: null,
      ownerId: "gone", now: "2026-11-04T00:00:00Z", leaseTtlMs: 1 });
    const foreign = await f.store.createIntent({ ...f.scope, sessionId: "other-account", allocationId: "foreign",
      provider: "test", providerNamespace: "other-account", configFingerprint: "config", expectedBindingRevision: null,
      ownerId: "foreign-owner", now: "2026-11-04T00:00:00Z", leaseTtlMs: 30_000 });
    if (foreign.type !== "created") throw new Error("expected foreign intent");
    const handle = await f.store.recordHandle({ fence: foreign.fence, expectedRevision: foreign.resource.revision,
      now: "2026-11-04T00:00:01Z", handle: { provider: "test", runtimeId: "foreign-runtime" } });
    if (handle.type !== "updated") throw new Error("expected foreign handle");
    await f.store.retire({ fence: foreign.fence, expectedRevision: handle.resource.revision, now: "2026-11-04T00:00:02Z" });
    const manager = f.service();
    const target = await manager.open(f.input);
    await manager.retire({ ...f.scope, allocationId: target.allocationId });
    const reaper = f.service("reaper", { reaper: { resume: resource => f.input.resume(resource.handle!), handle: f.input.handle } });
    expect(await reaper.reconcile({ limit: 1 })).toEqual([{ allocationId: target.allocationId, deleted: true }]);
    expect(f.destroyed).toEqual([target.resource.handle!.runtimeId]);
    expect((await f.store.find({ ...f.scope, sessionId: "old-intent", allocationId: "unknown" }))!.observedState).toBe("intent");
    expect((await f.store.find({ ...f.scope, sessionId: "other-account", allocationId: "foreign" }))!.observedState).toBe("allocated");
  });

  it("rotates a changed Session configuration within the same provider and keeps stale cleanup isolated", async () => {
    const f = await fixture();
    const manager = f.service();
    const first = await manager.open(f.input);
    const changed = await manager.open({ ...f.input, configFingerprint: "config-v2" });
    expect(changed.allocationId).not.toBe(first.allocationId);
    expect(changed.resource.configFingerprint).toBe("config-v2");
    expect((await f.store.find({ ...f.scope, allocationId: first.allocationId }))!.desiredState).toBe("retired");
    await manager.reap({ ...f.scope, allocationId: first.allocationId, resume: f.input.resume, handle: f.input.handle });
    expect((await f.store.getCurrent(f.scope))!.resource!.allocationId).toBe(changed.allocationId);
    expect(await changed.sandbox.readFile("file")).toBe("initial");
  });

  it("keeps partial preparation failure durable until explicit retirement", async () => {
    const f = await fixture();
    const manager = f.service();
    await expect(manager.open({ ...f.input, prepare: async sandbox => {
      await sandbox.writeFile("partially-prepared", "partial");
      throw new Error("package setup failed");
    } })).rejects.toThrow("package setup failed");
    const failed = (await f.store.getCurrent(f.scope))!.resource!;
    expect(failed).toMatchObject({ observedState: "lost", readiness: "none", handle: { provider: "test" } });
    await expect(f.service("restart").open(f.input)).rejects.toMatchObject({ code: "unknown_management", message: expect.stringContaining("package setup failed") });
    expect((await f.store.getCurrent(f.scope))!.resource!.failure).toBe(failed.failure);
    expect(f.input.create).toHaveBeenCalledTimes(1);
    await manager.retire({ ...f.scope, allocationId: failed.allocationId });
    const replacement = await manager.open(f.input);
    expect(replacement.allocationId).not.toBe(failed.allocationId);
    expect(await replacement.sandbox.readFile("partially-prepared")).toBe("");
  });

  it("fails visibly for unsupported factories and provider namespace changes without allocating", async () => {
    const f = await fixture();
    const unsupported = f.service("unsupported", { runtimeBindingSupported: false });
    await expect(unsupported.open(f.input)).rejects.toMatchObject({ code: "unsupported" });
    expect(await f.store.getCurrent(f.scope)).toBeNull();
    const manager = f.service();
    await manager.open(f.input);
    await expect(f.service("new-provider-account", { providerNamespace: "another-account" }).open(f.input)).rejects.toMatchObject({ code: "configuration_changed" });
    expect(f.input.create).toHaveBeenCalledTimes(1);
  });

  it("drains preparation on close without retiring the Session and refuses new operations", async () => {
    const f = await fixture();
    const manager = f.service();
    const started = deferred(); const finish = deferred();
    const opening = manager.open({ ...f.input, prepare: async (...args) => {
      started.resolve(); await finish.promise; await f.input.prepare(...args);
    } });
    await started.promise;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    expect(manager.close()).toBe(manager.close());
    await expect(manager.open(f.input)).rejects.toMatchObject({ code: "closed" });
    await expect(manager.describe(f.scope)).rejects.toMatchObject({ code: "closed" });
    expect(closed).toBe(false);
    finish.resolve();
    const opened = await opening;
    await closing;
    expect((await f.store.getCurrent(f.scope))!.resource).toMatchObject({
      allocationId: opened.allocationId, desiredState: "active", observedState: "ready", management: { ownerId: null },
    });
    expect(f.destroyed).toEqual([]);
  });

  it("bounds shutdown of an ignored cancellation and never registers or prepares its late create result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    const f = await fixture({ now: () => new Date(), leaseTtlMs: 120, renewIntervalMs: 30, drainTimeoutMs: 20 });
    const manager = f.service();
    const started = deferred(); const finish = deferred();
    let providerSignal!: AbortSignal;
    const register = vi.spyOn(f.store, "recordHandle");
    const renew = vi.spyOn(f.store, "renewManagement");
    const opening = manager.open({ ...f.input, create: async (allocationId, signal) => {
      providerSignal = signal;
      const sandbox = await f.input.create(allocationId);
      started.resolve(); await finish.promise; return sandbox;
    } });
    const rejected = expect(opening).rejects.toMatchObject({ code: "closed" });
    await started.promise;
    const closing = manager.close();
    await vi.advanceTimersByTimeAsync(21);
    await closing;
    await rejected;
    expect(providerSignal.aborted).toBe(true);
    expect((await f.store.getCurrent(f.scope))!.resource).toMatchObject({
      handle: null, observedState: "intent", desiredState: "active", management: { ownerId: "manager-a" },
    });
    // Simulate the host disposing its SQL client immediately after close().
    const databaseCall = vi.spyOn(f.sql, "prepare").mockImplementation(() => { throw new Error("SQL already closed"); });
    finish.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(databaseCall).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(f.input.prepare).not.toHaveBeenCalled();
    expect(f.destroyed).toEqual([]);
  });

  it("permanently closes an archived Session while preparation is pending without resurrecting its pointer", async () => {
    const f = await fixture();
    const manager = f.service();
    const started = deferred(); const finish = deferred();
    const opening = manager.open({ ...f.input, prepare: async (_sandbox, _allocation, _signal, authorization) => {
      started.resolve(); await finish.promise;
      expect(await authorization.isCurrent()).toBe(false);
    } });
    const rejected = expect(opening).rejects.toMatchObject({ code: "management_lost" });
    await started.promise;
    const allocationId = (await f.store.getCurrent(f.scope))!.resource!.allocationId;
    await manager.closeSession(f.scope);
    finish.resolve();
    await rejected;
    expect(await f.store.getCurrent(f.scope)).toMatchObject({ binding: { closed: true, allocationId: null }, resource: null });
    expect(await f.store.find({ ...f.scope, allocationId })).toMatchObject({ desiredState: "retired" });
    await expect(manager.open(f.input)).rejects.toThrow("permanently retired");
    await expect(f.service("restart").open(f.input)).rejects.toThrow("permanently retired");
    expect(f.input.create).toHaveBeenCalledTimes(1);
    expect(f.destroyed).toEqual([]);
  });

  it("keeps an archived Session's execution use until confirmed drain before cleanup", async () => {
    const f = await fixture();
    const manager = f.service("manager", { reaper: { resume: resource => f.input.resume(resource.handle!) } });
    const opened = await manager.open(f.input);
    const executionFence = await f.execution();
    await manager.borrow({ executionFence, allocationId: opened.allocationId });
    await manager.closeSession(f.scope);
    expect(await manager.reconcile()).toEqual([]);
    expect(await f.store.find({ ...f.scope, allocationId: opened.allocationId })).toMatchObject({
      desiredState: "retired", use: { attemptId: executionFence.attemptId },
    });
    await manager.release({ executionFence, allocationId: opened.allocationId, unknown: false });
    expect(await manager.reconcile()).toEqual([{ allocationId: opened.allocationId, deleted: true }]);
    expect(f.destroyed).toEqual([opened.resource.handle!.runtimeId]);
  });
});
