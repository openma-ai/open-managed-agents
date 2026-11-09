import {
  composeSandboxHarnessDrivers,
  createManagedRuntimeHost,
  createManagedRuntimeOrphanReconciler,
  SupervisedSandboxHarnessDriver,
  type RuntimeSchedulerPort,
} from "@open-managed-agents/managed-runtime-host";
import { SqlEnvironmentWorkClaimPort } from "@open-managed-agents/environment-work-store-sql";
import {
  ensureRuntimeOrphanSchema,
  SqlRuntimeOrphanPort,
} from "@open-managed-agents/sandbox-orphan-store-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  CredentialEgressCapabilities,
  CredentialEgressPort,
  EnvironmentWorkClaimPort,
  ManagedRuntimeProviderDriverPort,
  RuntimeCheckpointPort,
  SessionInputMaterializerPort,
} from "@open-managed-agents/runtime-resource-contract";

import {
  DockerManagedRuntimeAdapter,
  type DockerCommandPort,
} from "./docker";
import { NodeFilesystemSessionOutputPort } from "./outputs";
import { NodeFilesystemWorkspacePort } from "./workspace";

export interface CreateNodeManagedRuntimeOptions {
  rootDir: string;
  /** Holds the orphan queue and, unless `claims` is given, the control
   * plane's managed_environment_work rows the default claim Port reads. */
  sql: SqlClient;
  /** Explicit because production schema migration should remain operator-owned. */
  initializeOrphanSchema?: boolean;
  /** The Environment Work claim the host is authorized by (ADR 0005).
   * Defaults to SqlEnvironmentWorkClaimPort over `sql`, which requires the
   * host to share the control plane database. */
  claims?: EnvironmentWorkClaimPort;
  ownerId: string;
  heartbeatIntervalMs: number;
  /** Optional safe-point checkpoint target for supervised checkpoint_restore sessions. */
  checkpointIntervalMs?: number;
  image: string;
  network?: string;
  docker?: DockerCommandPort;
  additionalMounts?: readonly {
    source: string;
    destination: string;
    readOnly?: boolean;
  }[];
  extraHosts?: readonly { hostname: string; address: string }[];
  scheduler?: RuntimeSchedulerPort;
  /** Optional provider-owned process checkpoint adapter. */
  runtimeCheckpoint?: RuntimeCheckpointPort;
  /**
   * Operator-supplied enforced/advisory egress implementation. The default
   * Docker composition intentionally has none: proxy environment variables
   * alone are not a credential isolation boundary.
   */
  credentialEgress?: CredentialEgressPort;
  /** Optional stager for official Session resources and application metadata. */
  sessionInputs?: SessionInputMaterializerPort;
}

export interface CreateNodeManagedRuntimeDriverOptions
  extends CreateNodeManagedRuntimeOptions {
  /** Explicit static admission facts. Omission stays fail-closed even when a
   * dynamic egress Port was supplied. */
  credentialEgressCapabilities?: CredentialEgressCapabilities;
}

/** Preinstalled Node reference composition: Work claim + filesystem + Docker. */
export async function createNodeManagedRuntime(
  options: CreateNodeManagedRuntimeOptions,
) {
  if (options.initializeOrphanSchema === true) {
    await ensureRuntimeOrphanSchema(options.sql);
  }
  const claims = options.claims ?? new SqlEnvironmentWorkClaimPort(options.sql);
  const orphans = new SqlRuntimeOrphanPort(options.sql);
  const workspace = new NodeFilesystemWorkspacePort({ rootDir: options.rootDir });
  const outputs = new NodeFilesystemSessionOutputPort({ rootDir: options.rootDir });
  const sandbox = new DockerManagedRuntimeAdapter({
    image: options.image,
    ...(options.network === undefined ? {} : { network: options.network }),
    ...(options.docker === undefined ? {} : { docker: options.docker }),
    ...(options.additionalMounts === undefined
      ? {}
      : { additionalMounts: options.additionalMounts }),
    ...(options.extraHosts === undefined ? {} : { extraHosts: options.extraHosts }),
  });
  const sessionInputs = options.sessionInputs ?? sandbox;
  const supervisedHarness = new SupervisedSandboxHarnessDriver({
    transport: sandbox,
  });
  const harnessDriver = composeSandboxHarnessDrivers(
    sandbox,
    supervisedHarness,
  );
  const host = createManagedRuntimeHost({
    ownerId: options.ownerId,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    ...(options.checkpointIntervalMs === undefined ? {} : { checkpointIntervalMs: options.checkpointIntervalMs }),
    claims,
    sandbox,
    workspace,
    outputs,
    harnessDriver,
    orphans,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.runtimeCheckpoint === undefined
      ? {}
      : { runtimeCheckpoint: options.runtimeCheckpoint }),
    ...(options.credentialEgress === undefined
      ? {}
      : { credentialEgress: options.credentialEgress }),
    sessionInputs,
  });
  const orphanReconciler = createManagedRuntimeOrphanReconciler({ orphans, sandbox });
  return {
    host,
    claims,
    orphans,
    orphanReconciler,
    sandbox,
    workspace,
    outputs,
    harnessDriver,
    ...(options.runtimeCheckpoint === undefined
      ? {}
      : { runtimeCheckpoint: options.runtimeCheckpoint }),
    ...(options.credentialEgress === undefined
      ? {}
      : { credentialEgress: options.credentialEgress }),
    sessionInputs,
  };
}

/** Provider-driver projection of the preinstalled Node/Docker runtime. */
export function createNodeManagedRuntimeDriver(
  options: CreateNodeManagedRuntimeDriverOptions,
): ManagedRuntimeProviderDriverPort {
  return {
    descriptor() {
      return {
        provider: "node-docker",
        version: "1.0.0",
        placements: ["in_process"],
        capabilities: {
          sandbox: {
            suspendResume: "unsupported",
            hardTerminate: "supported",
            runtimeCheckpoints: [],
          },
          workspace: { strategies: ["checkpoint_restore"] },
          outputs: {
            strategies: [{ strategy: "final_collect", durability: "durable" }],
          },
          harness: { drivers: ["ama_worker", "openma_supervised"] },
        },
        credentialEgress: options.credentialEgressCapabilities ?? {
          enforcement: "unsupported",
          credentialMode: "snapshot",
          interceptedProtocols: [],
        },
      };
    },
    async create(input) {
      if (input.placement !== "in_process") {
        throw new Error(`Node/Docker does not support ${input.placement} placement`);
      }
      const runtime = await createNodeManagedRuntime(options);
      return {
        sandbox: runtime.sandbox,
        workspace: runtime.workspace,
        outputs: runtime.outputs,
        harnessDriver: runtime.harnessDriver,
        ...(runtime.runtimeCheckpoint === undefined
          ? {}
          : { runtimeCheckpoint: runtime.runtimeCheckpoint }),
        ...(runtime.credentialEgress === undefined
          ? {}
          : { credentialEgress: runtime.credentialEgress }),
        sessionInputs: runtime.sessionInputs,
      };
    },
  };
}
