import { describe, expect, it, vi } from "vitest";

import {
  createManagedRuntimeHost,
} from "../src/index";
import type { EnvironmentWorkClaim } from "@open-managed-agents/runtime-resource-contract";
import type { ManagedRuntimeHostDependencies } from "../src/index";
import {
  MemoryRuntimeOrphanPort,
  MemoryEnvironmentWorkClaimPort,
} from "../src/testing";

const scope = {
  workspaceId: "workspace_chaos",
  environmentId: "environment_chaos",
  sessionId: "session_chaos",
  workId: "work_chaos",
};

const claim = { generation: 11, token: "chaos-token" };

const profile = {
  workspace: { requirement: "durable" as const },
  outputs: { requirement: "durable" as const },
  runtimeCheckpoint: "disabled" as const,
  driver: {
    type: "ama_worker" as const,
    process: { command: "community-worker" },
  },
};

const postAcquireStages = [
  "workspace.materialize",
  "outputs.prepare",
  "sandbox.acquire",
  "workspace.attach",
  "outputs.attach",
  "harness.run",
  "workspace.checkpoint",
  "outputs.collect",
  "outputs.finalize",
  "claims.publish",
] as const;

type PostAcquireStage = (typeof postAcquireStages)[number];

function blockedScheduler() {
  return {
    sleep: (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  };
}

function chaosFixture(failAt: PostAcquireStage) {
  const trace: string[] = [];
  let loseRenew = false;
  const stage = <T>(name: PostAcquireStage, value: T) =>
    vi.fn(async (..._arguments: unknown[]) => {
      trace.push(name);
      if (name === failAt) throw new Error(`injected:${name}`);
      return value;
    });

  const dependencies = {
    ownerId: "chaos-owner",
    heartbeatIntervalMs: 30_000,
    scheduler: blockedScheduler(),
    orphans: new MemoryRuntimeOrphanPort(),
    claims: {
      open: vi.fn(async () => ({
        type: "current" as const,
        expiresAt: "2099-01-01T00:00:00.000Z",
        publication: null,
      })),
      isCurrent: vi.fn(async () => !loseRenew),
      publish: stage("claims.publish", { type: "published" as const, revision: 1 }),
    },
    sandbox: {
      capabilities: vi.fn(async () => ({
        suspendResume: "unsupported" as const,
        hardTerminate: "supported" as const,
        runtimeCheckpoints: [],
      })),
      acquire: stage("sandbox.acquire", { provider: "fake", runtimeId: "runtime-chaos" }),
      heartbeat: vi.fn(async () => ({ type: "alive" as const })),
      suspend: vi.fn(),
      terminate: vi.fn(async ({ reason }: { reason: string }) => {
        trace.push(`sandbox.terminate:${reason}`);
      }),
      reap: vi.fn(async () => {}),
      inspect: vi.fn(),
    },
    workspace: {
      capabilities: vi.fn(async () => ({ strategies: ["checkpoint_restore" as const] })),
      materialize: stage("workspace.materialize", {
        bindingId: "workspace-chaos",
        mountPath: "/workspace" as const,
      }),
      attach: stage("workspace.attach", undefined),
      checkpoint: stage("workspace.checkpoint", {
        id: "workspace-candidate",
        contentHash: "sha256:workspace",
        revision: 11,
      }),
      release: vi.fn(async () => {
        trace.push("workspace.release");
      }),
    },
    outputs: {
      capabilities: vi.fn(async () => ({
        strategies: [{ strategy: "final_collect" as const, durability: "durable" as const }],
      })),
      prepare: stage("outputs.prepare", {
        bindingId: "outputs-chaos",
        mountPath: "/mnt/session/outputs" as const,
      }),
      attach: stage("outputs.attach", undefined),
      collect: stage("outputs.collect", []),
      finalize: stage("outputs.finalize", {
        id: "outputs-candidate",
        contentHash: "sha256:outputs",
        entries: 0,
      }),
      release: vi.fn(async () => {
        trace.push("outputs.release");
      }),
      abort: vi.fn(async ({ reason }: { reason: string }) => {
        trace.push(`outputs.abort:${reason}`);
      }),
    },
    harnessDriver: {
      driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker" as const] })),
      run: stage("harness.run", { type: "completed" as const }),
    },
  };
  return {
    dependencies,
    trace,
    loseClaim() {
      loseRenew = true;
    },
  };
}

describe("managed runtime deterministic chaos matrix", () => {
  it.each(postAcquireStages)(
    "never publishes or releases a candidate when %s fails",
    async (failAt) => {
      const { dependencies, trace } = chaosFixture(failAt);
      await expect(
        createManagedRuntimeHost(
          dependencies as unknown as ManagedRuntimeHostDependencies,
        ).run({ scope, claim, profile }),
      ).resolves.toMatchObject({
        type: "failed",
        error: expect.objectContaining({ message: `injected:${failAt}` }),
      });

      expect(dependencies.outputs.release).not.toHaveBeenCalled();
      if (failAt !== "claims.publish") {
        expect(dependencies.claims.publish).not.toHaveBeenCalled();
      }

      const sandboxWasAllocated = postAcquireStages.indexOf(failAt) >
        postAcquireStages.indexOf("sandbox.acquire");
      expect(dependencies.sandbox.terminate).toHaveBeenCalledTimes(
        sandboxWasAllocated ? 1 : 0,
      );
      const outputWasPrepared = postAcquireStages.indexOf(failAt) >
        postAcquireStages.indexOf("outputs.prepare");
      expect(dependencies.outputs.abort).toHaveBeenCalledTimes(
        outputWasPrepared ? 1 : 0,
      );
      const workspaceWasMaterialized = postAcquireStages.indexOf(failAt) >
        postAcquireStages.indexOf("workspace.materialize");
      expect(dependencies.workspace.release).toHaveBeenCalledTimes(
        workspaceWasMaterialized ? 1 : 0,
      );
    },
  );

  it("stops a run that loses its Work claim while output finalization is in flight", async () => {
    let wakeMonitor!: () => void;
    const monitorMayRun = new Promise<void>((resolve) => {
      wakeMonitor = resolve;
    });
    const { dependencies, loseClaim } = chaosFixture("claims.publish");
    dependencies.scheduler = {
      sleep: async (_milliseconds: number, signal: AbortSignal) => {
        await Promise.race([
          monitorMayRun,
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        ]);
      },
    };
    loseClaim();
    dependencies.outputs.finalize.mockImplementation(async (rawInput: unknown) => {
      const { signal } = rawInput as { signal: AbortSignal };
      wakeMonitor();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
      throw new Error("unreachable");
    });

    await expect(
      createManagedRuntimeHost(
        dependencies as unknown as ManagedRuntimeHostDependencies,
      ).run({ scope, claim, profile }),
    ).resolves.toEqual({ type: "lease_lost" });
    expect(dependencies.claims.publish).not.toHaveBeenCalled();
    expect(dependencies.outputs.abort).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "lease_lost" }),
    );
    expect(dependencies.outputs.release).not.toHaveBeenCalled();
  });
});

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("Work claim seeded model chaos", () => {
  it.each([1, 7, 42, 2_026_090_3])(
    "only the newest unlost claim publishes, for seed %i",
    async (seed) => {
      const store = new MemoryEnvironmentWorkClaimPort();
      const random = mulberry32(seed);
      const held: EnvironmentWorkClaim[] = [];

      for (let step = 0; step < 250; step += 1) {
        const action = Math.floor(random() * 4);
        if (action === 0 || held.length === 0) {
          held.push(store.claim(scope));
        } else if (action === 1) {
          if (random() < 0.5) store.requestStop(scope);
          else store.lose(scope);
        } else {
          const candidate = held[Math.floor(random() * held.length)]!;
          const before = store.inspect(scope)!;
          const holds = before.state !== "lost"
            && before.generation === candidate.generation
            && before.token === candidate.token;
          if (action === 2) {
            await expect(store.isCurrent(candidate)).resolves.toBe(holds);
          } else {
            const publication = await store.publish({
              claim: candidate,
              workspaceCandidate: {
                id: `workspace:${candidate.generation}`,
                contentHash: `sha256:${candidate.generation}`,
              },
              outputCandidate: null,
            });
            expect(publication.type).toBe(holds ? "published" : "lost");
            const observed = store.inspect(scope)!;
            if (publication.type === "published") {
              expect(observed.publication).toMatchObject({
                generation: candidate.generation,
                revision: publication.revision,
              });
            } else {
              expect(observed.publication).toEqual(before.publication);
            }
          }
        }

        const observed = store.inspect(scope);
        const current = [];
        for (const candidate of held) {
          if (await store.isCurrent(candidate)) current.push(candidate);
        }
        expect(current.length).toBeLessThanOrEqual(1);
        if (observed?.publication !== null && observed?.publication !== undefined) {
          expect(observed.publication.generation).toBeLessThanOrEqual(observed.generation);
          expect(observed.publication.revision).toBeGreaterThan(0);
        }
      }
    },
  );
});
