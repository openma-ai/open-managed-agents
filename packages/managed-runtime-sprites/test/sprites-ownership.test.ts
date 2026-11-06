import { describe, expect, it, vi } from "vitest";
import type { RuntimeResourceFence, RuntimeOrphanRecord } from "@open-managed-agents/runtime-resource-contract";
import { createManagedRuntimeOrphanReconciler } from "../../managed-runtime-host/src/orphan-reconciler";
import { createSpritesManagedRuntime, type SpriteSdkPort, type SpritesClientPort } from "../src/sprites";

const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
const oldFence = { ...scope, ownerId: "old-owner", generation: 1, token: "old-secret", expiresAt: "2020-01-01T00:00:00Z" };
const newFence = { ...oldFence, ownerId: "new-owner", generation: 2, token: "new-secret", expiresAt: "2099-01-01T00:00:00Z" };

function providerApi() {
  const resources = new Map<string, SpriteSdkPort>();
  const missing = () => Object.assign(new Error("not found"), { status: 404 });
  const deleteSprite = vi.fn(async (name: string) => { resources.delete(name); });
  const client: SpritesClientPort = {
    getSprite: async (name) => {
      const sprite = resources.get(name);
      if (!sprite) throw missing();
      return sprite;
    },
    createSprite: async (name, options) => {
      const sprite = {
        name, labels: options?.labels ?? [],
        check: async () => {
          if (!resources.has(name)) throw missing();
          return { status: "running" };
        },
        execFileHTTP: async (_file: string, args: string[] = []) => {
          if (!resources.has(name)) throw missing();
          return {
            stdout: args.some((arg) => arg.includes("__OPENMA_RUNTIME_READY__")) ? "__OPENMA_RUNTIME_READY__" : "",
            stderr: "", exitCode: 0,
          };
        },
        closeControlConnection() {},
      } as SpriteSdkPort;
      resources.set(name, sprite);
      return sprite;
    },
    deleteSprite,
  };
  return { client, resources, deleteSprite };
}

async function acquire(host: ReturnType<typeof createSpritesManagedRuntime>, fence: RuntimeResourceFence) {
  const signal = new AbortController().signal;
  const workspace = await host.workspace.materialize({
    scope, fence, strategy: "retained_runtime", activeCheckpoint: null, idempotencyKey: "workspace", signal,
  });
  return host.sandbox.acquire({
    scope, fence, workspace, outputs: null, signal,
    plan: { workspaceStrategy: "retained_runtime", outputStrategy: null, runtimeCheckpoint: null,
      driver: { type: "ama_worker", process: { command: "worker" } } },
  });
}

describe("Sprites managed allocation retirement", () => {
  it("a delayed expired-owner delete cannot remove a successor allocated by another composition", async () => {
    const api = providerApi();
    const first = createSpritesManagedRuntime({ client: api.client, leaseTtlMs: 90_000 });
    const second = createSpritesManagedRuntime({ client: api.client, leaseTtlMs: 90_000 });
    const a = await acquire(first, oldFence);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    api.deleteSprite.mockImplementationOnce(async (name) => {
      await deleteGate;
      api.resources.delete(name);
    });
    const retiring = first.sandbox.terminate({ scope, fence: oldFence, lease: a, reason: "lease_lost" });
    const b = await acquire(second, newFence);
    expect(a.runtimeId).not.toBe(b.runtimeId);
    expect(api.resources.size).toBe(2);
    releaseDelete();
    await retiring;
    expect(api.resources.has(a.runtimeId)).toBe(false);
    expect(api.resources.has(b.runtimeId)).toBe(true);
    await expect(second.sandbox.inspect(b)).resolves.toEqual({ state: "running" });
    expect(api.deleteSprite).toHaveBeenCalledExactlyOnceWith(a.runtimeId);
  });

  it("a serialized old orphan is reaped after restart without deleting the live successor", async () => {
    const api = providerApi();
    const first = createSpritesManagedRuntime({ client: api.client, leaseTtlMs: 90_000 });
    const a = await acquire(first, oldFence);
    api.deleteSprite.mockRejectedValueOnce(new Error("delete unavailable"));
    await expect(first.sandbox.terminate({ scope, fence: oldFence, lease: a, reason: "lease_lost" }))
      .rejects.toThrow("delete unavailable");
    const second = createSpritesManagedRuntime({ client: api.client, leaseTtlMs: 90_000 });
    const b = await acquire(second, newFence);
    const orphan: RuntimeOrphanRecord = JSON.parse(JSON.stringify({
      id: "old-orphan", scope, ownerId: oldFence.ownerId, generation: oldFence.generation,
      sandbox: a, reason: "lease_lost", attempts: 0, lastError: "delete unavailable",
    }));
    const orphans = {
      enqueue: vi.fn(), list: vi.fn(async () => [orphan]), resolve: vi.fn(), failed: vi.fn(),
    };
    const restarted = createSpritesManagedRuntime({ client: api.client, leaseTtlMs: 90_000 });
    const reconciler = createManagedRuntimeOrphanReconciler({ sandbox: restarted.sandbox, orphans });
    await expect(reconciler.runOnce({ limit: 10 })).resolves.toEqual({ inspected: 1, resolved: 1, remaining: 0 });
    expect(orphans.resolve).toHaveBeenCalledExactlyOnceWith({ id: orphan.id });
    expect(api.resources.has(a.runtimeId)).toBe(false);
    expect(api.resources.has(b.runtimeId)).toBe(true);
    await expect(second.sandbox.heartbeat({ scope, fence: newFence, lease: b })).resolves.toEqual({ type: "alive" });
    expect(api.deleteSprite.mock.calls.map(([name]) => name)).toEqual([a.runtimeId, a.runtimeId]);
  });

  it("keeps historical orphans unresolved when they have no isolated allocation identity", async () => {
    const api = providerApi();
    const live = createSpritesManagedRuntime({ client: api.client, leaseTtlMs: 90_000 });
    const lease = await acquire(live, newFence);
    const { allocation: _allocation, ...historical } = lease;
    const orphan: RuntimeOrphanRecord = {
      id: "legacy", scope, ownerId: oldFence.ownerId, generation: oldFence.generation,
      sandbox: historical, reason: "lease_lost", attempts: 0, lastError: "legacy record",
    };
    const orphans = { enqueue: vi.fn(), list: vi.fn(async () => [orphan]), resolve: vi.fn(), failed: vi.fn() };
    const restarted = createSpritesManagedRuntime({ client: api.client, leaseTtlMs: 90_000 });
    const reconciler = createManagedRuntimeOrphanReconciler({ sandbox: restarted.sandbox, orphans });
    await expect(reconciler.runOnce({ limit: 10 })).resolves.toEqual({ inspected: 1, resolved: 0, remaining: 1 });
    expect(orphans.resolve).not.toHaveBeenCalled();
    expect(orphans.failed).toHaveBeenCalledWith(expect.objectContaining({ id: "legacy" }));
    expect(api.deleteSprite).not.toHaveBeenCalled();
    expect(api.resources.has(lease.runtimeId)).toBe(true);
  });
});
