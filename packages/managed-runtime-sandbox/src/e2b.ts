import {
  sandboxProvider,
  type E2BSandboxExecutor,
} from "@open-managed-agents/sandbox/adapters/e2b";
import type {
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxProviderPort,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { BlobStore } from "@open-managed-agents/blob-store/ports";
import { S3BlobStore } from "@open-managed-agents/blob-store/adapters/s3";

import { createProviderManagedRuntime } from "./provider-runtime";

export interface E2BManagedRuntimeOptions {
  environment:
    | SandboxFactoryEnv
    | ((scope: RuntimeResourceScope) => SandboxFactoryEnv);
  leaseTtlMs: number;
  context?: (scope: RuntimeResourceScope) => SandboxFactoryContext;
  /** Test/custom-compatible-service seam; defaults to the official E2B adapter. */
  provider?: SandboxProviderPort<E2BSandboxExecutor>;
  /** Explicit output target, useful with per-scope environment functions. */
  outputStore?: BlobStore | null;
}

function filesStoreFromEnvironment(environment: SandboxFactoryEnv): BlobStore | null {
  const endpoint = environment.FILES_S3_ENDPOINT;
  const bucket = environment.FILES_S3_BUCKET;
  const accessKeyId = environment.FILES_S3_ACCESS_KEY;
  const secretAccessKey = environment.FILES_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return new S3BlobStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: environment.FILES_S3_REGION ?? "us-east-1",
    forcePathStyle: environment.FILES_S3_FORCE_PATH_STYLE !== "false",
    prefix: environment.FILES_S3_PREFIX,
  });
}

/**
 * Preconfigured E2B composition. The same adapter works with E2B-compatible
 * endpoints because connection details remain in SandboxFactoryEnv.
 */
export function createE2BManagedRuntime(options: E2BManagedRuntimeOptions) {
  const configuredEnvironment = options.environment;
  const environment: (scope: RuntimeResourceScope) => SandboxFactoryEnv =
    typeof configuredEnvironment === "function"
      ? configuredEnvironment
      : () => configuredEnvironment;
  const outputStore = options.outputStore === null
    ? null
    : options.outputStore
      ?? (typeof configuredEnvironment === "function"
        ? null
        : filesStoreFromEnvironment(configuredEnvironment));
  return createProviderManagedRuntime({
    providerName: "e2b",
    provider: options.provider ?? sandboxProvider,
    context:
      options.context
      ?? ((scope) => ({
        sessionId: scope.sessionId,
        workdir: "/workspace",
      })),
    environment,
    leaseTtlMs: options.leaseTtlMs,
    sandboxCapabilities: {
      suspendResume: "supported",
      hardTerminate: "supported",
      // E2B memory snapshots are used below as workspace restore points.
      // Do not also advertise process checkpointing until RuntimeCheckpointPort
      // is wired into the host's restore transaction.
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["retained_runtime", "checkpoint_restore"],
      retainedSuspendKind: "memory",
      portableCheckpointKind: "memory",
    },
    ...(outputStore === null
      ? {}
      : {
          outputs: {
            store: outputStore,
            keyPrefix: "managed-runtime-output-candidates",
            durability: "durable" as const,
          },
        }),
    drivers: ["ama_worker"],
  });
}
