import { CfR2BlobStore } from "@open-managed-agents/blob-store/adapters/cf-r2";
import {
  composeSandboxHarnessDrivers,
  createManagedEnvironmentWorker,
  createManagedRuntimeHost,
  createManagedRuntimeOrphanReconciler,
  SupervisedSandboxHarnessDriver,
  type ManagedEnvironmentWorkerOptions,
} from "@open-managed-agents/managed-runtime-host";
import {
  createPreinstalledRuntimeEnvironment,
  createProviderManagedRuntime,
  requireRuntimeEnvironmentArtifact,
  type ProviderManagedRuntimeProviderPort,
  type ProviderRuntimeEnvironment,
} from "@open-managed-agents/managed-runtime-sandbox";
import type {
  ManagedRuntimeProviderDriverPort,
  RuntimeCheckpointPort,
  SessionInputMaterializerPort,
} from "@open-managed-agents/runtime-resource-contract";
import {
  SqlRuntimeOrphanPort,
  SqlRuntimeResourceFencePort,
} from "@open-managed-agents/runtime-resource-fence-sql";
import {
  supportsSessionOutputMount,
  type SandboxCheckpointHandle,
  type SandboxFactoryContext,
  type SandboxDuplexProcessPort,
  type SandboxPort,
  type SandboxProviderPort,
  type SandboxRuntimePort,
} from "@open-managed-agents/sandbox";
import type { Env } from "@open-managed-agents/shared";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

export interface CloudflareManagedRuntimeSandbox
  extends SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  destroy(): Promise<void>;
  setOutboundContext(input: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
    workId: string;
    ownerId: string;
    generation: number;
    fenceToken: string;
    required: boolean;
    controlPlaneBaseUrl?: string;
  }): Promise<void>;
  revokeOutboundContext(input: {
    workId: string;
    generation: number;
    reason: "completed" | "failed" | "lease_lost";
  }): Promise<void>;
  /** Live unversioned R2 mount. Its bytes are not part of sandbox checkpoints. */
  mountDurableWorkspace(input: { workspaceId: string; sessionId: string }): Promise<void>;
}

export interface CloudflareManagedRuntimeOptions {
  leaseTtlMs?: number;
  /** The Cloudflare application supplies its SDK-backed Sandbox/DO wrapper.
   * Keeping that primitive here as a Port prevents this package from importing
   * the application or leaking SDK types into the generic Runtime Host. */
  createSandbox(env: Env, runtimeId: string): CloudflareManagedRuntimeSandbox;
  /** API origin reachable from the container for scoped Work/MCP traffic. */
  controlPlaneBaseUrl?: string;
  runtimeEnvironment?: ProviderRuntimeEnvironment<CloudflareManagedRuntimeSandbox>;
  /** Opt in to a session-scoped R2 mount at /workspace. No snapshot/rollback. */
  workspaceDurableMount?: boolean;
}

export interface CloudflareManagedRuntimeHostOptions
  extends CloudflareManagedRuntimeOptions {
  /** Stable identity of this SessionDO/worker instance; never a user token. */
  ownerId: string;
  heartbeatIntervalMs?: number;
  /** Safe-point target for checkpoint_restore; mount strategy never snapshots. */
  checkpointIntervalMs?: number;
  runtimeCheckpoint?: RuntimeCheckpointPort;
  sessionInputs?: SessionInputMaterializerPort;
}

export interface CloudflareManagedRuntimeDriverOptions
  extends CloudflareManagedRuntimeOptions {
  sessionInputs?: SessionInputMaterializerPort;
}

export interface CloudflareManagedEnvironmentWorkerOptions {
  runtime: CloudflareManagedRuntimeHostOptions;
  worker: Omit<ManagedEnvironmentWorkerOptions, "host">;
}

export interface CloudflareManagedRuntimeProviderFactoryOptions
  extends CloudflareManagedRuntimeDriverOptions {
  env: Env;
}

export function cloudflareWorkspaceMountPrefix(workspaceId: string, sessionId: string): string {
  for (const [label, value] of [["workspaceId", workspaceId], ["sessionId", sessionId]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
      throw new Error(`Unsafe workspace mount ${label}`);
    }
  }
  return `openma-workspaces/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sessionId)}/`;
}

function durableWorkspaceMountConfigured(env: Env, enabled: boolean | undefined): boolean {
  if (!enabled) return false;
  if (
    !env.WORKSPACE_BUCKET
    || !env.WORKSPACE_BUCKET_NAME?.trim()
    || !env.R2_ENDPOINT?.trim()
    || !env.R2_ACCESS_KEY_ID?.trim()
    || !env.R2_SECRET_ACCESS_KEY?.trim()
  ) {
    throw new Error("Cloudflare workspace R2 durable mount requires WORKSPACE_BUCKET, WORKSPACE_BUCKET_NAME, R2_ENDPOINT and R2 credentials");
  }
  return true;
}

export function createCloudflareSandboxProvider(
  env: Env,
  instantiate: CloudflareManagedRuntimeOptions["createSandbox"],
): SandboxProviderPort<CloudflareManagedRuntimeSandbox> {
  const allocation = (context: SandboxFactoryContext) => {
    const runtimeId = context.allocationId ?? context.sessionId;
    const sandbox = instantiate(env, runtimeId);
    if (context.allocationId !== undefined && sandbox.runtimeHandle().runtimeId !== runtimeId) {
      throw new Error("Cloudflare sandbox factory did not honor the isolated allocation identity");
    }
    return sandbox;
  };
  return {
    create: async (context) => allocation(context),
    resume: async () => {
      throw new Error(
        "Cloudflare runtime-scoped resume is unsupported; use a portable filesystem checkpoint",
      );
    },
    restore: async (checkpoint: SandboxCheckpointHandle, context) => {
      const sandbox = allocation(context);
      await sandbox.resume(checkpoint);
      return sandbox;
    },
  };
}

/** Direct Cloudflare binding composition. Cloudflare createBackup/restoreBackup
 * is a portable filesystem checkpoint, not a warm process resume. */
export function createCloudflareManagedRuntime(
  env: Env,
  options: CloudflareManagedRuntimeOptions,
) {
  const hasDurableOutputMount = Boolean(
    env.FILES_BUCKET
      && env.R2_ENDPOINT
      && env.R2_ACCESS_KEY_ID
      && env.R2_SECRET_ACCESS_KEY,
  );
  const hasDurableWorkspaceMount = durableWorkspaceMountConfigured(env, options.workspaceDurableMount);
  const instantiate = options.createSandbox;
  const sandboxProvider = createCloudflareSandboxProvider(env, instantiate);
  const allocationForReap = (runtimeId: string) => {
    const runtime = instantiate(env, runtimeId);
    if (runtime.runtimeHandle().runtimeId !== runtimeId) {
      throw new Error("Cloudflare orphan reconnect returned a different runtime identity");
    }
    return runtime;
  };
  const provider: ProviderManagedRuntimeProviderPort<CloudflareManagedRuntimeSandbox> = {
    // Only the physical Durable Object key changes per allocation. Logical
    // Session identity still comes from acquisition.scope for mounts/egress.
    allocationIsolation: true,
    create: (context, factoryEnvironment, acquisition) => {
      if (acquisition === undefined) {
        throw new Error("Cloudflare managed allocation requires acquisition context");
      }
      requireRuntimeEnvironmentArtifact(
        acquisition.environment,
        "cloudflare",
        ["preinstalled", "bootstrap"],
      );
      return sandboxProvider.create(context, factoryEnvironment);
    },
    resume: (handle, context, factoryEnvironment) =>
      sandboxProvider.resume(handle, context, factoryEnvironment),
    restore: (checkpoint, context, factoryEnvironment, acquisition) => {
      if (acquisition === undefined) {
        throw new Error("Cloudflare managed restore requires acquisition context");
      }
      requireRuntimeEnvironmentArtifact(
        acquisition.environment,
        "cloudflare",
        ["preinstalled", "bootstrap"],
      );
      return sandboxProvider.restore(checkpoint, context, factoryEnvironment);
    },
  };

  return createProviderManagedRuntime<CloudflareManagedRuntimeSandbox>({
    providerName: "cloudflare",
    provider,
    context: (scope) => ({ sessionId: scope.sessionId, workdir: "/workspace" }),
    environment: () => ({}),
    runtimeEnvironment: options.runtimeEnvironment
      ?? createPreinstalledRuntimeEnvironment({
        type: "base",
        identity: "cloudflare:preinstalled",
      }),
    leaseTtlMs: options.leaseTtlMs ?? 90_000,
    sandboxCapabilities: {
      suspendResume: "unsupported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["checkpoint_restore"],
      portableCheckpointKind: "filesystem",
      ...(hasDurableWorkspaceMount
        ? {
            durableMount: {
              identity: (scope: { workspaceId: string; sessionId: string }) =>
                `r2://${env.WORKSPACE_BUCKET_NAME!}/${cloudflareWorkspaceMountPrefix(scope.workspaceId, scope.sessionId)}`,
              async attach({ runtime, scope, signal }: {
                runtime: CloudflareManagedRuntimeSandbox;
                scope: { workspaceId: string; sessionId: string };
                signal: AbortSignal;
              }) {
                signal.throwIfAborted();
                if (typeof runtime.mountDurableWorkspace !== "function") {
                  throw new Error("Cloudflare runtime does not expose the workspace R2 mount Port");
                }
                await runtime.mountDurableWorkspace({ workspaceId: scope.workspaceId, sessionId: scope.sessionId });
                signal.throwIfAborted();
              },
            },
          }
        : {}),
    },
    reapRuntime: async ({ lease, context }) => {
      if (lease.runtimeId !== context.allocationId) {
        throw new Error("Cloudflare orphan allocation identity mismatch");
      }
      await allocationForReap(lease.runtimeId).destroy();
    },
    credentialEgress: {
      capabilities: {
        enforcement: "enforced",
        credentialMode: "live",
        interceptedProtocols: ["http", "https"],
      },
      async attach({ runtime, scope, fence, requirement, signal }) {
        signal.throwIfAborted();
        await runtime.setOutboundContext({
          tenantId: scope.workspaceId,
          environmentId: scope.environmentId,
          sessionId: scope.sessionId,
          workId: scope.workId,
          ownerId: fence.ownerId,
          generation: fence.generation,
          fenceToken: fence.token,
          required: requirement === "required",
          ...(options.controlPlaneBaseUrl === undefined
            ? {}
            : { controlPlaneBaseUrl: options.controlPlaneBaseUrl }),
        });
        signal.throwIfAborted();
      },
      async revoke({ runtime, scope, fence, reason }) {
        await runtime.revokeOutboundContext({
          workId: scope.workId,
          generation: fence.generation,
          reason,
        });
      },
    },
    ...(env.FILES_BUCKET === undefined
      ? {}
      : {
          outputs: {
            store: new CfR2BlobStore(env.FILES_BUCKET),
            keyPrefix: "managed-runtime-output-candidates",
            durability: "durable" as const,
            ...(hasDurableOutputMount
              ? {
                  durableMount: {
                    durability: "durable" as const,
                    async attach({ runtime, scope, signal }) {
                      signal.throwIfAborted();
                      if (!supportsSessionOutputMount(runtime)) {
                        throw new Error(
                          "Cloudflare runtime does not expose the Session output mount Port",
                        );
                      }
                      await runtime.mountSessionOutputs({
                        tenantId: scope.workspaceId,
                        sessionId: scope.sessionId,
                      });
                      signal.throwIfAborted();
                    },
                  },
                }
              : {}),
          },
        }),
    drivers: ["ama_worker"],
  });
}

export function createCloudflareManagedRuntimeDriver(
  env: Env,
  options: CloudflareManagedRuntimeDriverOptions,
): ManagedRuntimeProviderDriverPort {
  const hasDurableWorkspaceMount = durableWorkspaceMountConfigured(env, options.workspaceDurableMount);
  const hasOutputStore = env.FILES_BUCKET !== undefined;
  const hasDurableOutputMount = Boolean(
    env.FILES_BUCKET
      && env.R2_ENDPOINT
      && env.R2_ACCESS_KEY_ID
      && env.R2_SECRET_ACCESS_KEY,
  );
  return {
    descriptor() {
      return {
        provider: "cloudflare",
        version: "1.0.0",
        placements: ["in_process"],
        capabilities: {
          sandbox: {
            suspendResume: "unsupported",
            hardTerminate: "supported",
            runtimeCheckpoints: [],
          },
          workspace: {
            strategies: ["checkpoint_restore", ...(hasDurableWorkspaceMount ? ["durable_mount" as const] : [])],
          },
          outputs: {
            strategies: hasOutputStore
              ? [
                  ...(hasDurableOutputMount
                    ? [{ strategy: "durable_mount" as const, durability: "durable" as const }]
                    : []),
                  { strategy: "final_collect" as const, durability: "durable" as const },
                ]
              : [],
          },
          harness: { drivers: ["ama_worker", "openma_supervised"] },
        },
        credentialEgress: {
          enforcement: "enforced",
          credentialMode: "live",
          interceptedProtocols: ["http", "https"],
        },
      };
    },
    async create(input) {
      if (input.placement !== "in_process") {
        throw new Error(`Cloudflare does not support ${input.placement} placement`);
      }
      const runtime = createCloudflareManagedRuntime(env, options);
      const harnessDriver = composeSandboxHarnessDrivers(
        runtime.harness,
        new SupervisedSandboxHarnessDriver({ transport: runtime.supervisorTransport }),
      );
      return {
        sandbox: runtime.sandbox,
        workspace: runtime.workspace,
        outputs: runtime.outputs,
        harnessDriver,
        supervisorTransport: runtime.supervisorTransport,
        credentialEgress: runtime.credentialEgress!,
        sessionInputs: options.sessionInputs ?? runtime.sessionInputs,
      };
    },
  };
}

export function createManagedRuntimeProviderDriver(
  options: CloudflareManagedRuntimeProviderFactoryOptions,
): ManagedRuntimeProviderDriverPort {
  const { env, ...runtime } = options;
  return createCloudflareManagedRuntimeDriver(env, runtime);
}

export function createCloudflareManagedRuntimeHost(
  env: Env,
  options: CloudflareManagedRuntimeHostOptions,
) {
  const runtime = createCloudflareManagedRuntime(env, options);
  const sql = new CfD1SqlClient(env.MAIN_DB);
  const fences = new SqlRuntimeResourceFencePort(sql);
  const orphans = new SqlRuntimeOrphanPort(sql);
  const harnessDriver = composeSandboxHarnessDrivers(
    runtime.harness,
    new SupervisedSandboxHarnessDriver({ transport: runtime.supervisorTransport }),
  );
  const leaseTtlMs = options.leaseTtlMs ?? 90_000;
  const host = createManagedRuntimeHost({
    ownerId: options.ownerId,
    leaseTtlMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    ...(options.checkpointIntervalMs === undefined ? {} : { checkpointIntervalMs: options.checkpointIntervalMs }),
    fences,
    sandbox: runtime.sandbox,
    workspace: runtime.workspace,
    outputs: runtime.outputs,
    credentialEgress: runtime.credentialEgress,
    harnessDriver,
    orphans,
    ...(options.runtimeCheckpoint === undefined
      ? {}
      : { runtimeCheckpoint: options.runtimeCheckpoint }),
    sessionInputs: options.sessionInputs ?? runtime.sessionInputs,
  });
  const orphanReconciler = createManagedRuntimeOrphanReconciler({
    orphans,
    sandbox: runtime.sandbox,
  });
  return {
    ...runtime,
    fences,
    orphans,
    harnessDriver,
    host,
    orphanReconciler,
    sessionInputs: options.sessionInputs ?? runtime.sessionInputs,
  };
}

export function createCloudflareManagedEnvironmentWorker(
  env: Env,
  options: CloudflareManagedEnvironmentWorkerOptions,
) {
  const runtime = createCloudflareManagedRuntimeHost(env, {
    ...options.runtime,
    controlPlaneBaseUrl: options.runtime.controlPlaneBaseUrl
      ?? options.worker.sandboxApiBaseUrl
      ?? options.worker.client.baseURL,
  });
  return {
    ...runtime,
    environmentWorker: createManagedEnvironmentWorker({
      ...options.worker,
      host: runtime.host,
    }),
  };
}
