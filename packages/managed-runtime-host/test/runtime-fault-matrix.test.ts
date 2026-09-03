import { describe, expect, it, vi } from "vitest";

import {
  createManagedRuntimeHost,
  createManagedRuntimeOrphanReconciler,
} from "../src/index";
import { MemoryRuntimeOrphanPort } from "../src/testing";

const scope = {
  workspaceId: "workspace_fault",
  environmentId: "environment_fault",
  sessionId: "session_fault",
  workId: "work_fault",
};
const fence = {
  ...scope,
  ownerId: "fault-owner",
  generation: 1,
  token: "fault-secret",
  expiresAt: "2026-09-03T12:00:00.000Z",
};
const profile = {
  workspace: { requirement: "durable" as const },
  outputs: { requirement: "durable" as const },
  runtimeCheckpoint: "disabled" as const,
  driver: {
    type: "ama_worker" as const,
    process: { command: "community-worker" },
  },
};

function blockedScheduler() {
  return {
    sleep: (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  };
}

function fixture(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const base: any = {
    ownerId: "fault-owner",
    leaseTtlMs: 90_000,
    heartbeatIntervalMs: 30_000,
    scheduler: blockedScheduler(),
    orphans: new MemoryRuntimeOrphanPort(),
    fences: {
      acquire: vi.fn(async () => ({ type: "acquired", fence, publication: null })),
      renew: vi.fn(async () => ({ type: "renewed", fence })),
      publish: vi.fn(async () => ({ type: "published", revision: 1 })),
      release: vi.fn(async ({ reason }: { reason: string }) => calls.push(`release:${reason}`)),
    },
    sandbox: {
      capabilities: vi.fn(async () => ({
        suspendResume: "unsupported",
        hardTerminate: "supported",
        runtimeCheckpoints: [],
      })),
      acquire: vi.fn(async () => ({ provider: "fake", runtimeId: "runtime-fault" })),
      heartbeat: vi.fn(async () => ({ type: "alive" })),
      suspend: vi.fn(),
      terminate: vi.fn(async ({ reason }: { reason: string }) =>
        calls.push(`terminate:${reason}`)
      ),
      reap: vi.fn(async () => {}),
      inspect: vi.fn(),
    },
    workspace: {
      capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore"] })),
      materialize: vi.fn(async () => ({
        bindingId: "workspace-fault",
        mountPath: "/workspace",
      })),
      attach: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({
        id: "workspace-candidate",
        contentHash: "sha256:workspace",
        revision: 1,
      })),
      release: vi.fn(async () => calls.push("workspace.release")),
    },
    outputs: {
      capabilities: vi.fn(async () => ({
        strategies: [{ strategy: "final_collect", durability: "durable" }],
      })),
      prepare: vi.fn(async () => ({
        bindingId: "outputs-fault",
        mountPath: "/mnt/session/outputs",
      })),
      attach: vi.fn(async () => {}),
      collect: vi.fn(async () => []),
      finalize: vi.fn(async () => ({
        id: "outputs-candidate",
        contentHash: "sha256:outputs",
        entries: 0,
      })),
      release: vi.fn(async () => calls.push("outputs.release")),
      abort: vi.fn(async ({ reason }: { reason: string }) => calls.push(`outputs.abort:${reason}`)),
    },
    harnessDriver: {
      driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
      run: vi.fn(async () => ({ type: "completed" })),
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = typeof value === "object" && value !== null
      ? { ...base[key], ...value }
      : value;
  }
  return { dependencies: base, calls };
}

describe("Managed Runtime Host fault matrix", () => {
  it("rejects unsupported driver/output/checkpoint profiles before fence acquisition", async () => {
    const { dependencies } = fixture({
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: [],
        })),
      },
      outputs: {
        capabilities: vi.fn(async () => ({
          strategies: [{ strategy: "final_collect", durability: "best_effort" }],
        })),
      },
    });
    const host = createManagedRuntimeHost(dependencies);
    await expect(host.run({ scope, profile })).rejects.toThrow(/durable.*outputs/i);
    expect(dependencies.fences.acquire).not.toHaveBeenCalled();

    const missingDriver = fixture({
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["openma_supervised"] })),
      },
    });
    await expect(
      createManagedRuntimeHost(missingDriver.dependencies).run({ scope, profile }),
    ).rejects.toThrow(/ama_worker/i);
    expect(missingDriver.dependencies.fences.acquire).not.toHaveBeenCalled();

    const missingCheckpoint = fixture();
    await expect(
      createManagedRuntimeHost(missingCheckpoint.dependencies).run({
        scope,
        profile: { ...profile, runtimeCheckpoint: "required" },
      }),
    ).rejects.toThrow(/runtime checkpoint/i);
    expect(missingCheckpoint.dependencies.fences.acquire).not.toHaveBeenCalled();
  });

  it.each([
    ["harness", { harnessDriver: { run: vi.fn(async () => { throw new Error("harness failed"); }) } }],
    ["workspace checkpoint", { workspace: { checkpoint: vi.fn(async () => { throw new Error("checkpoint failed"); }) } }],
    ["output finalization", { outputs: { finalize: vi.fn(async () => { throw new Error("finalize failed"); }) } }],
  ])("cleans every allocated resource when %s fails", async (_phase, overrides) => {
    const { dependencies, calls } = fixture(overrides as Record<string, any>);
    await expect(
      createManagedRuntimeHost(dependencies).run({ scope, profile }),
    ).resolves.toMatchObject({ type: "failed" });
    expect(dependencies.fences.publish).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "terminate:failed",
      "outputs.abort:failed",
      "workspace.release",
      "release:failed",
    ]);
  });

  it("treats a rejected atomic publication as lease loss and never releases outputs", async () => {
    const { dependencies, calls } = fixture({
      fences: { publish: vi.fn(async () => ({ type: "lost" })) },
    });
    await expect(
      createManagedRuntimeHost(dependencies).run({ scope, profile }),
    ).resolves.toEqual({ type: "lease_lost" });
    expect(calls).toEqual([
      "terminate:lease_lost",
      "outputs.abort:lease_lost",
      "workspace.release",
      "release:lease_lost",
    ]);
    expect(dependencies.outputs.release).not.toHaveBeenCalled();
  });

  it("persists failed hard termination without the fence secret and reaps it later", async () => {
    const orphans = new MemoryRuntimeOrphanPort();
    const terminate = vi.fn(async () => {
      throw new Error("provider control plane unavailable");
    });
    const reap = vi.fn(async () => {});
    const { dependencies } = fixture({
      sandbox: { terminate, reap },
    });
    dependencies.orphans = orphans;

    await expect(
      createManagedRuntimeHost(dependencies).run({ scope, profile }),
    ).resolves.toEqual({ type: "completed", revision: 1 });
    const pending = await orphans.list({ limit: 10 });
    expect(pending).toEqual([
      expect.objectContaining({
        scope,
        generation: fence.generation,
        ownerId: fence.ownerId,
        sandbox: { provider: "fake", runtimeId: "runtime-fault" },
        reason: "completed",
        attempts: 0,
        lastError: "provider control plane unavailable",
      }),
    ]);
    expect(JSON.stringify(pending)).not.toContain(fence.token);

    const reconciler = createManagedRuntimeOrphanReconciler({
      orphans,
      sandbox: dependencies.sandbox,
    });
    await expect(reconciler.runOnce({ limit: 10 })).resolves.toEqual({
      inspected: 1,
      resolved: 1,
      remaining: 0,
    });
    expect(reap).toHaveBeenCalledWith({
      scope,
      lease: { provider: "fake", runtimeId: "runtime-fault" },
      reason: "completed",
    });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([]);
  });

  it("retains an orphan and increments its attempt when reconciliation still fails", async () => {
    const orphans = new MemoryRuntimeOrphanPort();
    await orphans.enqueue({
      scope,
      generation: 9,
      ownerId: "owner-stale",
      sandbox: { provider: "fake", runtimeId: "runtime-stale" },
      reason: "lease_lost",
      error: new Error("initial kill failed"),
    });
    const { dependencies } = fixture({
      sandbox: {
        reap: vi.fn(async () => {
          throw new Error("still partitioned");
        }),
      },
    });
    const reconciler = createManagedRuntimeOrphanReconciler({
      orphans,
      sandbox: dependencies.sandbox,
    });

    await expect(reconciler.runOnce({ limit: 10 })).resolves.toEqual({
      inspected: 1,
      resolved: 0,
      remaining: 1,
    });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ attempts: 1, lastError: "still partitioned" }),
    ]);
  });
});
