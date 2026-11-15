import { describe, expect, it, vi } from "vitest";

import {
  createManagedRuntimeProviderHost,
  type ManagedRuntimeProviderDriverPort,
} from "../src/index";

const scope = {
  workspaceId: "workspace_provider_host",
  environmentId: "environment_provider_host",
  sessionId: "session_provider_host",
  workId: "work_provider_host",
};

const claim = { generation: 1, token: "work-token-1" };

const profile = {
  workspace: { requirement: "ephemeral" as const },
  outputs: { requirement: "disabled" as const },
  runtimeCheckpoint: "disabled" as const,
  driver: {
    type: "ama_worker" as const,
    process: { command: "managed-worker" },
  },
};

function driver(create: ManagedRuntimeProviderDriverPort["create"]): ManagedRuntimeProviderDriverPort {
  return {
    descriptor: () => ({
      provider: "acme",
      version: "1.0.0",
      placements: ["driver_service"],
      capabilities: {
        sandbox: {
          suspendResume: "unsupported",
          hardTerminate: "supported",
          runtimeCheckpoints: [],
        },
        workspace: { strategies: ["ephemeral"] },
        outputs: { strategies: [] },
        harness: { drivers: ["ama_worker"] },
      },
      credentialEgress: {
        enforcement: "unsupported",
        credentialMode: "snapshot",
        interceptedProtocols: [],
      },
    }),
    create,
  };
}

describe("provider-backed Managed Runtime Host", () => {
  it("passes provider-owned config through the registry before entering the common Work-claim state machine", async () => {
    const providerConfig = { endpoint: "https://sandbox.acme.test", pool: "warm" };
    const create = vi.fn<ManagedRuntimeProviderDriverPort["create"]>(async () => ({
      sandbox: {
        capabilities: vi.fn(async () => ({
          suspendResume: "unsupported" as const,
          hardTerminate: "supported" as const,
          runtimeCheckpoints: [],
        })),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["ephemeral" as const] })),
      },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [] })),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker" as const] })),
      },
    } as never));
    const open = vi.fn(async () => ({ type: "lost" as const }));
    const host = createManagedRuntimeProviderHost({
      driver: driver(create),
      placement: "driver_service",
      providerConfig,
      ownerId: "worker_01",
      heartbeatIntervalMs: 30_000,
      claims: { open } as never,
      orphans: {} as never,
    });

    await expect(host.run({ scope, claim, profile })).resolves.toEqual({ type: "lease_lost" });
    expect(create).toHaveBeenCalledWith({
      environmentId: scope.environmentId,
      placement: "driver_service",
      plan: {
        workspaceStrategy: "ephemeral",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: profile.driver,
      },
      profile,
      providerConfig,
    });
    expect(open).toHaveBeenCalledOnce();
    const invalid = createManagedRuntimeProviderHost({
      driver: driver(create), placement: "driver_service", providerConfig,
      ownerId: "worker_01", heartbeatIntervalMs: 30_000,
      checkpointIntervalMs: 0, claims: { open } as never, orphans: {} as never,
    });
    await expect(invalid.run({ scope, claim, profile })).rejects.toThrow(/checkpointIntervalMs/);
  });

  it("fails capability admission before a provider adapter can allocate resources", async () => {
    const create = vi.fn<ManagedRuntimeProviderDriverPort["create"]>(async () => {
      throw new Error("must not allocate");
    });
    const host = createManagedRuntimeProviderHost({
      driver: driver(create),
      placement: "driver_service",
      providerConfig: {},
      ownerId: "worker_01",
      heartbeatIntervalMs: 30_000,
      claims: {} as never,
      orphans: {} as never,
    });

    await expect(host.run({
      scope,
      claim,
      profile: { ...profile, workspace: { requirement: "durable" } },
    })).rejects.toThrow(/durable workspace/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("passes every optional provider Port and scheduler into the common host", async () => {
    const create = vi.fn<ManagedRuntimeProviderDriverPort["create"]>(async () => ({
      sandbox: {
        capabilities: vi.fn(async () => ({ suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: [] })),
      },
      workspace: {
        capabilities: vi.fn(async () => ({ strategies: ["ephemeral"] })),
      },
      outputs: {
        capabilities: vi.fn(async () => ({ strategies: [] })),
      },
      harnessDriver: {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] })),
      },
      runtimeCheckpoint: { restore: vi.fn(), checkpoint: vi.fn() },
      credentialEgress: {
        capabilities: vi.fn(async () => ({ enforcement: "unsupported", credentialMode: "snapshot", interceptedProtocols: [] })),
        issue: vi.fn(),
        revoke: vi.fn(),
      },
      sessionInputs: { materialize: vi.fn(), release: vi.fn() },
    } as never));
    const scheduler = { sleep: vi.fn() } as never;
    const host = createManagedRuntimeProviderHost({
      driver: driver(create),
      placement: "driver_service",
      providerConfig: {},
      ownerId: "worker_01",
      heartbeatIntervalMs: 30_000,
      claims: { open: vi.fn(async () => ({ type: "lost" as const })) } as never,
      orphans: {} as never,
      scheduler,
    });

    await expect(host.run({ scope, claim, profile })).resolves.toMatchObject({ type: "lease_lost" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("admits repository Sessions as credential-egress-required before creating provider resources", async () => {
    const create = vi.fn<ManagedRuntimeProviderDriverPort["create"]>(async () => {
      throw new Error("must not allocate");
    });
    const host = createManagedRuntimeProviderHost({
      driver: driver(create),
      placement: "driver_service",
      providerConfig: {},
      ownerId: "worker_01",
      heartbeatIntervalMs: 30_000,
      claims: {} as never,
      orphans: {} as never,
    });

    await expect(host.run({
      scope,
      claim,
      profile,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "github_repository",
          url: "https://github.com/openma-ai/example.git",
          mount_path: "/workspace/example",
        }],
      },
    })).rejects.toThrow(/credential egress/i);
    expect(create).not.toHaveBeenCalled();
  });
});
