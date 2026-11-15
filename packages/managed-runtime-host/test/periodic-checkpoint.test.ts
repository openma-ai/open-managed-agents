import { describe, expect, it, vi } from "vitest";
import { createManagedRuntimeHost } from "../src/host";
import { MemoryEnvironmentWorkClaimPort, MemoryRuntimeOrphanPort } from "../src/testing";

const scope = {
  workspaceId: "workspace_1", environmentId: "environment_1",
  sessionId: "session_1", workId: "work_1",
};
const supervised = {
  type: "openma_supervised" as const,
  protocol: "openma-harness-supervisor-v1" as const,
  supervisor: { command: "supervisor" },
  harness: { id: "pi", version: "1" },
  readyTimeoutMs: 5_000, heartbeatTimeoutMs: 10_000, drainTimeoutMs: 5_000,
};
const profile = {
  workspace: { requirement: "durable" as const, preferredStrategies: ["checkpoint_restore" as const] },
  outputs: { requirement: "disabled" as const },
  runtimeCheckpoint: "disabled" as const,
  driver: supervised,
};

function fixture(input: {
  strategy?: "checkpoint_restore" | "durable_mount";
  intervalMs?: number;
  onRun?: (value: any) => Promise<{ type: "completed" }>;
}) {
  const claims = new MemoryEnvironmentWorkClaimPort();
  const workClaim = claims.claim(scope);
  const claim = { generation: workClaim.generation, token: workClaim.token };
  const candidate = vi.fn(async () => ({ id: "candidate", contentHash: "sha256:abc", revision: 1 }));
  let periodicSleeps = 0;
  const host = createManagedRuntimeHost({
    ownerId: "worker_1", heartbeatIntervalMs: 30_000,
    ...(input.intervalMs === undefined ? {} : { checkpointIntervalMs: input.intervalMs }),
    scheduler: {
      sleep: (ms: number, signal: AbortSignal) => ms === input.intervalMs && periodicSleeps++ === 0
        ? Promise.resolve()
        : new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
    claims,
    orphans: new MemoryRuntimeOrphanPort(),
    sandbox: {
      capabilities: vi.fn(async () => ({
        hardTerminate: "supported" as const, suspendResume: "unsupported" as const,
        runtimeCheckpoints: [],
      })),
      acquire: vi.fn(async () => ({ provider: "fake", runtimeId: "runtime_1" })),
      suspend: vi.fn(async () => ({ provider: "fake", runtimeId: "runtime_1" })),
      heartbeat: vi.fn(async () => ({ type: "alive" as const })),
      terminate: vi.fn(async () => {}),
      reap: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({ state: "stopped" as const })),
    },
    workspace: {
      capabilities: vi.fn(async () => ({ strategies: [input.strategy ?? "checkpoint_restore"] })),
      materialize: vi.fn(async () => ({ mountPath: "/workspace" as const, bindingId: "workspace_1" })),
      attach: vi.fn(async () => {}),
      checkpoint: candidate,
      release: vi.fn(async () => {}),
    },
    outputs: {
      capabilities: vi.fn(async () => ({ strategies: [] })),
      prepare: vi.fn(), attach: vi.fn(), collect: vi.fn(), finalize: vi.fn(),
      abort: vi.fn(), release: vi.fn(),
    },
    harnessDriver: {
      driverCapabilities: vi.fn(async () => ({ drivers: ["openma_supervised" as const, "ama_worker" as const] })),
      run: vi.fn(input.onRun ?? (async () => ({ type: "completed" as const }))),
    },
  });
  return { host, claims, claim, candidate, periodicSleeps: () => periodicSleeps };
}

describe("opt-in periodic workspace checkpoint requests", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects invalid interval %s", (intervalMs) => {
    expect(() => fixture({ intervalMs })).toThrow("checkpointIntervalMs must be a positive integer");
  });

  it("is off by default and does not request a checkpoint for durable mounts", async () => {
    const defaultRun = vi.fn(async (input: any) => {
      expect(input.onCheckpointRequester).toBeUndefined();
      return { type: "completed" as const };
    });
    const disabled = fixture({ onRun: defaultRun });
    await expect(disabled.host.run({ scope, claim: disabled.claim, profile })).resolves.toMatchObject({ type: "completed" });
    expect(disabled.periodicSleeps()).toBe(0);

    const mount = fixture({ intervalMs: 100, strategy: "durable_mount", onRun: defaultRun });
    await expect(mount.host.run({ scope, claim: mount.claim, profile: {
      ...profile, workspace: { requirement: "durable", preferredStrategies: ["durable_mount"] },
    } })).resolves.toMatchObject({ type: "completed" });
    expect(mount.periodicSleeps()).toBe(0);
  });

  it("rejects unsupported direct-worker cadence instead of claiming scheduled checkpoints", async () => {
    const result = fixture({ intervalMs: 100 });
    await expect(result.host.run({ scope, claim: result.claim, profile: {
      ...profile, driver: { type: "ama_worker", process: { command: "node" } },
    } })).rejects.toThrow("Periodic workspace checkpoints require the supervised harness driver");
  });

  it("requests one safe-point checkpoint at a time and publishes only through the Work claim", async () => {
    let safePoint!: () => void;
    const reachedSafePoint = new Promise<void>((resolve) => { safePoint = resolve; });
    let checkpointCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { checkpointCommitted = resolve; });
    let requesterCalls = 0;
    const fixtureResult = fixture({ intervalMs: 100, onRun: async (input) => {
      input.onCheckpointRequester(async () => {
        requesterCalls += 1;
        await reachedSafePoint;
        await input.checkpoint({ checkpointId: `periodic_${requesterCalls}`, sessionId: scope.sessionId });
        checkpointCommitted();
      });
      await vi.waitFor(() => expect(requesterCalls).toBe(1));
      expect(fixtureResult.candidate).not.toHaveBeenCalled();
      expect(fixtureResult.periodicSleeps()).toBe(1); // no second request while pending
      safePoint();
      await committed;
      return { type: "completed" };
    } });
    const publish = vi.spyOn(fixtureResult.claims, "publish");
    await expect(fixtureResult.host.run({ scope, claim: fixtureResult.claim, profile })).resolves.toMatchObject({ type: "completed" });
    expect(fixtureResult.candidate).toHaveBeenCalledTimes(2); // safe point and final
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("leaves the active pointer intact when a periodic candidate fails", async () => {
    const fixtureResult = fixture({ intervalMs: 100, onRun: async (input) => {
      input.onCheckpointRequester(async () => {
        await input.checkpoint({ checkpointId: "periodic_bad", sessionId: scope.sessionId });
      });
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
      return { type: "completed" };
    } });
    fixtureResult.candidate.mockRejectedValueOnce(new Error("upload failed"));
    const publish = vi.spyOn(fixtureResult.claims, "publish");
    await expect(fixtureResult.host.run({ scope, claim: fixtureResult.claim, profile })).resolves.toMatchObject({ type: "failed" });
    expect(publish).not.toHaveBeenCalled();
    expect(fixtureResult.claims.inspect(scope)?.publication).toBeNull();
  });
});
