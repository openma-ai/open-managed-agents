import { describe, expect, it, vi } from "vitest";
import type { ManagedSandboxLease, RuntimeResourceFence } from "@open-managed-agents/runtime-resource-contract";
import {
  acquire, composition, fence, plan, provider, runtime, scope,
} from "./provider-runtime-fixture";

const successor = { ...fence, ownerId: "successor", generation: 2, token: "next-secret" };

async function retainedCandidate(composed: ReturnType<typeof composition>, lease: ManagedSandboxLease) {
  const suspended = await composed.sandbox.suspend({ scope, fence, lease, signal: new AbortController().signal });
  return composed.workspace.checkpoint({
    scope, fence, strategy: "retained_runtime", sandbox: suspended,
    binding: { bindingId: "retained", mountPath: "/workspace" },
    idempotencyKey: "retained", signal: new AbortController().signal,
  });
}

async function resumeCandidate(
  composed: ReturnType<typeof composition>,
  activeCheckpoint: Awaited<ReturnType<typeof retainedCandidate>>,
  nextFence: RuntimeResourceFence,
) {
  const workspace = await composed.workspace.materialize({
    scope, fence: nextFence, strategy: "retained_runtime", activeCheckpoint,
    idempotencyKey: "resume", signal: new AbortController().signal,
  });
  return composed.sandbox.acquire({
    scope, fence: nextFence, plan, workspace, outputs: null, signal: new AbortController().signal,
  });
}

describe("independent provider allocation ownership", () => {
  it("requires an explicit isolation declaration before allocating compute", async () => {
    const selected = { ...provider(), allocationIsolation: undefined };
    await expect(acquire(composition(selected))).rejects.toThrow(/does not declare independent allocation isolation/i);
    expect(selected.create).not.toHaveBeenCalled();
  });

  it("passes a unique identity into each acquisition and persists no fence secret", async () => {
    const first = runtime("physical-first");
    const second = runtime("physical-second");
    const selected = provider(first);
    vi.mocked(selected.create).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const composed = composition(selected);
    const a = await acquire(composed);
    const b = await acquire(composed);
    expect(a.allocation?.id).not.toBe(b.allocation?.id);
    expect(Object.isFrozen(a.allocation)).toBe(true);
    expect(Object.isFrozen(a.allocation?.scope)).toBe(true);
    expect(selected.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      allocationId: a.allocation?.id, workspaceId: scope.workspaceId, environmentId: scope.environmentId,
    }), {}, expect.anything());
    expect(JSON.stringify(a)).not.toContain(fence.token);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    await composed.sandbox.terminate({ scope, fence, lease: a, reason: "lease_lost" });
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).not.toHaveBeenCalled();
    await expect(composed.sandbox.heartbeat({ scope, fence, lease: b })).resolves.toEqual({ type: "alive" });
  });

  it("rejects a different owner or token before destructive cleanup", async () => {
    const live = runtime();
    const composed = composition(provider(live));
    const lease = await acquire(composed);
    for (const staleFence of [successor, { ...fence, token: "wrong-token" }]) {
      await expect(composed.sandbox.terminate({ scope, fence: staleFence, lease, reason: "lease_lost" }))
        .rejects.toThrow(/owner mismatch/i);
    }
    expect(live.destroy).not.toHaveBeenCalled();
    await expect(composed.sandbox.heartbeat({ scope, fence, lease })).resolves.toEqual({ type: "alive" });
  });

  it("does not transfer a retained allocation to a new owner or a restarted composition", async () => {
    const selected = provider();
    const first = composition(selected);
    const lease = await acquire(first);
    const candidate = await retainedCandidate(first, lease);
    await expect(resumeCandidate(first, candidate, successor)).rejects.toThrow(/ownership transfer is unsupported/i);
    await expect(resumeCandidate(composition(selected), candidate, fence)).rejects.toThrow(/ownership transfer is unsupported/i);
    expect(selected.resume).not.toHaveBeenCalled();
    await expect(first.sandbox.inspect(lease)).resolves.toEqual({ state: "running" });
  });

  it("makes retirement irreversible before waiting for a provider delete", async () => {
    let finishDelete!: () => void;
    const deleting = new Promise<void>((resolve) => { finishDelete = resolve; });
    const live = runtime("retiring", { destroy: vi.fn(() => deleting) });
    const selected = provider(live);
    const composed = composition(selected);
    const lease = await acquire(composed);
    const candidate = await retainedCandidate(composed, lease);
    const termination = composed.sandbox.terminate({ scope, fence, lease, reason: "failed" });
    await expect(resumeCandidate(composed, candidate, fence)).rejects.toThrow(/ownership transfer is unsupported/i);
    await expect(composed.sandbox.heartbeat({ scope, fence, lease })).resolves.toEqual({ type: "lost" });
    expect(selected.resume).not.toHaveBeenCalled();
    finishDelete();
    await termination;
  });

  it("refuses historical orphans without isolated allocation proof", async () => {
    const selected = provider();
    const reapRuntime = vi.fn();
    const composed = composition(selected, { reapRuntime });
    await expect(composed.sandbox.reap({
      scope, lease: { provider: "e2b", runtimeId: "historical-retained" }, reason: "lease_lost",
    })).rejects.toThrow(/legacy retained resources require explicit migration/i);
    expect(selected.resume).not.toHaveBeenCalled();
    expect(reapRuntime).not.toHaveBeenCalled();
  });

  it("never destroys a different resource returned while reconnecting an orphan", async () => {
    const original = runtime("original");
    const first = composition(provider(original));
    const lease = await acquire(first);
    vi.mocked(original.destroy!).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(first.sandbox.terminate({ scope, fence, lease, reason: "failed" })).rejects.toThrow("provider unavailable");
    const successorRuntime = runtime("successor");
    const selected = provider(successorRuntime);
    await expect(composition(selected).sandbox.reap({
      scope, lease: JSON.parse(JSON.stringify(lease)), reason: "failed",
    })).rejects.toThrow(/different runtime identity/i);
    expect(successorRuntime.destroy).not.toHaveBeenCalled();
  });

  it("restores portable data into independent compute while old cleanup remains harmless", async () => {
    const original = runtime("original");
    const first = composition(provider(original));
    const lease = await acquire(first, { strategy: "checkpoint_restore" });
    const candidate = await first.workspace.checkpoint({
      scope, fence, strategy: "checkpoint_restore", sandbox: lease,
      binding: { bindingId: "original", mountPath: "/workspace" },
      idempotencyKey: "portable", signal: new AbortController().signal,
    });
    const restored = runtime("restored");
    const selected = provider(restored);
    const second = composition(selected);
    const workspace = await second.workspace.materialize({
      scope, fence: successor, strategy: "checkpoint_restore", activeCheckpoint: candidate,
      idempotencyKey: "restore", signal: new AbortController().signal,
    });
    const restoredLease = await second.sandbox.acquire({
      scope, fence: successor, plan: { ...plan, workspaceStrategy: "checkpoint_restore" },
      workspace, outputs: null, signal: new AbortController().signal,
    });
    expect(restoredLease.allocation?.id).not.toBe(lease.allocation?.id);
    expect(selected.restore).toHaveBeenCalledWith(expect.objectContaining({ sourceRuntimeId: "original" }),
      expect.objectContaining({ allocationId: restoredLease.allocation?.id }), {}, expect.anything());
    await first.sandbox.terminate({ scope, fence, lease, reason: "lease_lost" });
    expect(restored.destroy).not.toHaveBeenCalled();
    await expect(second.sandbox.heartbeat({ scope, fence: successor, lease: restoredLease })).resolves.toEqual({ type: "alive" });
  });
});
