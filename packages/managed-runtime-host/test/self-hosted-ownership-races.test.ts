// Characterization of the three self-hosted ownership races (ADR 0005).
// The scenarios and assertions are the contract; only `ownership()` knows
// which store holds the authority, so the same suite survives a change of
// authority store.
import { describe, expect, it, vi } from "vitest";

import { createManagedRuntimeHost } from "../src/index";
import { MemoryEnvironmentWorkClaimPort, MemoryRuntimeOrphanPort } from "../src/testing";

const scope = {
  workspaceId: "workspace_race",
  environmentId: "environment_race",
  sessionId: "session_race",
  workId: "work_race",
};
const profile = {
  workspace: { requirement: "durable" as const },
  outputs: { requirement: "disabled" as const },
  runtimeCheckpoint: "disabled" as const,
  driver: { type: "ama_worker" as const, process: { command: "community-worker" } },
};
const session = {
  id: scope.sessionId,
  environmentId: scope.environmentId,
  metadata: {},
  resources: [{ type: "memory_store", memory_store_id: "memstore_1", access: "read_write" }],
};

/** The authority store, seen only through these operations. */
function ownership(options: ConstructorParameters<typeof MemoryEnvironmentWorkClaimPort>[0] = {}) {
  const claims = new MemoryEnvironmentWorkClaimPort(options);
  // Worker A's poll claimed the Work; the host runs under that claim.
  const { generation, token } = claims.claim(scope);
  return {
    dependencies: { claims },
    runInput: { claim: { generation, token } },
    /** Another worker becomes the owner of this Work and publishes its own candidate. */
    async takeOver(): Promise<void> {
      const next = claims.claim(scope);
      await claims.publish({
        claim: next,
        workspaceCandidate: { id: "workspace-b", contentHash: "sha256:b" },
        outputCandidate: null,
      });
    },
    /** The workspace candidate a replacement would restore from. */
    published(): string | null {
      return claims.inspect(scope)?.publication?.workspaceCandidate.id ?? null;
    },
  };
}

function manualScheduler() {
  const pending: Array<() => void> = [];
  return {
    sleep: (_ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      pending.push(resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    tick() { for (const resolve of pending.splice(0)) resolve(); },
  };
}

function fixture(owner: ReturnType<typeof ownership>, overrides: Record<string, any> = {}) {
  const base: any = {
    ownerId: "owner_a",
    heartbeatIntervalMs: 30_000,
    scheduler: manualScheduler(),
    orphans: new MemoryRuntimeOrphanPort(),
    ...owner.dependencies,
    sandbox: {
      capabilities: vi.fn(async () => ({ suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: [] })),
      acquire: vi.fn(async () => ({ provider: "fake", runtimeId: "runtime-a" })),
      heartbeat: vi.fn(async () => ({ type: "alive" })),
      suspend: vi.fn(),
      terminate: vi.fn(async () => {}),
      reap: vi.fn(async () => {}),
      inspect: vi.fn(),
    },
    workspace: {
      capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore"] })),
      materialize: vi.fn(async () => ({ bindingId: "workspace-a", mountPath: "/workspace" })),
      attach: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => ({ id: "workspace-a", contentHash: "sha256:a", revision: 1 })),
      release: vi.fn(async () => {}),
    },
    outputs: {
      capabilities: vi.fn(async () => ({ strategies: [] })),
      prepare: vi.fn(), attach: vi.fn(), collect: vi.fn(), finalize: vi.fn(),
      release: vi.fn(async () => {}), abort: vi.fn(async () => {}),
    },
    harnessDriver: {
      driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
      run: vi.fn(async () => ({ type: "completed" })),
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = typeof value === "object" && value !== null && !Array.isArray(value) ? { ...base[key], ...value } : value;
  }
  return base;
}

describe("self-hosted ownership races (characterization)", () => {
  it("baseline: the current owner publishes the workspace pointer", async () => {
    const owner = ownership();
    const result = await createManagedRuntimeHost(fixture(owner)).run({ scope, profile, ...owner.runInput });
    expect(result).toMatchObject({ type: "completed" });
    expect(owner.published()).toBe("workspace-a");
  });

  it("publishes final workspace and outputs after the official worker force-stops its claim", async () => {
    const owner = ownership();
    const scheduler = manualScheduler();
    const dependencies = fixture(owner, {
      scheduler,
      workspace: { checkpoint: vi.fn(async () => {
        scheduler.tick();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { id: "workspace-a", contentHash: "sha256:a", revision: 1 };
      }) },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [{ strategy: "final_collect", durability: "durable" }] })),
        prepare: vi.fn(async () => ({ bindingId: "outputs", mountPath: "/outputs" })),
        collect: vi.fn(async () => []),
        finalize: vi.fn(async () => ({ id: "output-a", contentHash: "sha256:out" })),
      },
      harnessDriver: {
        run: vi.fn(async () => {
          // Force stop revokes the actual authority, not just the API response.
          owner.dependencies.claims.stop(scope);
          return { type: "completed" };
        }),
      },
    });
    const result = await createManagedRuntimeHost(dependencies).run({
      scope, profile: { ...profile, outputs: { requirement: "durable" } }, ...owner.runInput,
    });
    expect(result).toEqual({ type: "completed", revision: 1 });
    expect(owner.dependencies.claims.inspect(scope)?.publication?.outputCandidate?.id).toBe("output-a");
    await expect(owner.dependencies.claims.isCurrent({ ...scope, ...owner.runInput.claim })).resolves.toBe(false);
    await expect(owner.dependencies.claims.open({ ...scope, ...owner.runInput.claim })).resolves.toEqual({ type: "lost" });
  });

  it.each([false, true])("renews through slow finalization and publish, then stops (abort=%s)", async (abort) => {
    const owner = ownership();
    const scheduler = manualScheduler();
    const controller = new AbortController();
    let finishCheckpoint!: () => void;
    let finishPublish!: () => void;
    const checkpointGate = new Promise<void>((resolve) => { finishCheckpoint = resolve; });
    const publishGate = new Promise<void>((resolve) => { finishPublish = resolve; });
    const dependencies = fixture(owner, {
      scheduler,
      workspace: { checkpoint: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        await checkpointGate;
        signal.throwIfAborted();
        return { id: "workspace-a", contentHash: "sha256:a", revision: 1 };
      }) },
      harnessDriver: { run: vi.fn(async () => {
        owner.dependencies.claims.stop(scope);
        return { type: "completed" };
      }) },
    });
    const publish = vi.spyOn(owner.dependencies.claims, "publish").mockImplementation(async () => {
      await publishGate;
      return { type: "published", revision: 1 };
    });
    const running = createManagedRuntimeHost(dependencies).run({
      scope, profile, ...owner.runInput, signal: controller.signal,
    });
    await vi.waitFor(() => expect(dependencies.workspace.checkpoint).toHaveBeenCalled());
    // Each tick represents a complete sandbox heartbeat interval after stop.
    for (let count = 1; count <= 2; count += 1) {
      scheduler.tick();
      await vi.waitFor(() => expect(dependencies.sandbox.heartbeat).toHaveBeenCalledTimes(count));
    }
    if (abort) controller.abort();
    finishCheckpoint();
    if (!abort) {
      await vi.waitFor(() => expect(publish).toHaveBeenCalled());
      scheduler.tick();
      await vi.waitFor(() => expect(dependencies.sandbox.heartbeat).toHaveBeenCalledTimes(3));
    }
    finishPublish();
    await expect(running).resolves.toMatchObject({ type: abort ? "lease_lost" : "completed" });
    const count = dependencies.sandbox.heartbeat.mock.calls.length;
    scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dependencies.sandbox.heartbeat).toHaveBeenCalledTimes(count);
    if (abort) expect(publish).not.toHaveBeenCalled();
  });

  it("race 1: a stale owner's publication is lost and the new owner's pointer stays", async () => {
    const owner = ownership();
    const dependencies = fixture(owner, {
      workspace: {
        // Owner A stalls in the final checkpoint; B reclaims and publishes meanwhile.
        checkpoint: vi.fn(async () => {
          await owner.takeOver();
          return { id: "workspace-a", contentHash: "sha256:a", revision: 1 };
        }),
      },
    });
    const result = await createManagedRuntimeHost(dependencies).run({ scope, profile, ...owner.runInput });
    expect(result).toEqual({ type: "lease_lost" });
    expect(owner.published()).toBe("workspace-b");
    expect(dependencies.sandbox.terminate).toHaveBeenCalledWith(expect.objectContaining({ reason: "lease_lost" }));
  });

  it("race 2: an ama_worker host discovers lost ownership while the worker runs and aborts it", async () => {
    const owner = ownership();
    const scheduler = manualScheduler();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const dependencies = fixture(owner, {
      scheduler,
      harnessDriver: {
        run: vi.fn(async (input: { signal: AbortSignal }) => {
          started();
          await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
          return { type: "aborted" };
        }),
      },
    });
    const result = createManagedRuntimeHost(dependencies).run({ scope, profile, ...owner.runInput });
    await running;
    await owner.takeOver();
    scheduler.tick();
    await expect(result).resolves.toEqual({ type: "lease_lost" });
    expect(dependencies.workspace.checkpoint).not.toHaveBeenCalled();
    expect(owner.published()).toBe("workspace-b");
    expect(dependencies.sandbox.terminate).toHaveBeenCalledWith(expect.objectContaining({ reason: "lease_lost" }));
  });

  it("aborts the host on natural claim expiry without an explicit loss", async () => {
    let now = 1_000;
    const owner = ownership({ now: () => new Date(now), ttlMs: 30_000 });
    const scheduler = manualScheduler();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const dependencies = fixture(owner, {
      scheduler,
      harnessDriver: {
        run: vi.fn(async (input: { signal: AbortSignal }) => {
          started();
          await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
          return { type: "aborted" };
        }),
      },
    });
    const result = createManagedRuntimeHost(dependencies).run({ scope, profile, ...owner.runInput });
    await running;
    now += 30_000;
    scheduler.tick();
    await expect(result).resolves.toEqual({ type: "lease_lost" });
    expect(owner.published()).toBeNull();
    expect(dependencies.workspace.checkpoint).not.toHaveBeenCalled();
  });

  it("race 3: after another owner takes over, the stale sandbox's Session-input mutations are refused", async () => {
    const owner = ownership();
    const verdicts: boolean[] = [];
    const dependencies = fixture(owner, {
      sessionInputs: {
        materialize: vi.fn(async (input: { authorize(): Promise<boolean> }) => {
          verdicts.push(await input.authorize());
          await owner.takeOver();
          verdicts.push(await input.authorize());
        }),
        synchronize: vi.fn(async () => {}),
      },
    });
    const result = await createManagedRuntimeHost(dependencies).run({ scope, profile, session, ...owner.runInput });
    expect(verdicts).toEqual([true, false]);
    expect(result).toEqual({ type: "lease_lost" });
    expect(dependencies.harnessDriver.run).not.toHaveBeenCalled();
  });
});
