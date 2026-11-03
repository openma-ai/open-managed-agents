import type { ControlPlaneStores } from "@openma/core/storage";
import type { FileContentStore } from "@openma/core/storage/file-content";
import type {
  SessionCreateAdmissionHookPort,
  SessionCreateDailyCounterPort,
  SessionCreateRateLimiterPort,
  SessionWorkAdmissionPort,
} from "@openma/core";
import { memoryStores } from "@openma/stores-memory";
import {
  createApp,
  providePort,
  type App,
  type AppModule,
} from "@open-managed-agents/app";
import {
  managedAgentsFeatureModules,
  type ManagedAgentsFeatures,
} from "@open-managed-agents/app/features";
import {
  clockPort,
  httpClientPort,
  idGeneratorPort,
  workspaceContextPort,
  type ClockPort,
  type HttpClientPort,
  type IdGeneratorPort,
} from "@open-managed-agents/app/capabilities";
import { agentStorePort } from "@open-managed-agents/app/modules/agents";
import { deploymentStorePort } from "@open-managed-agents/app/modules/deployments";
import { deploymentRunStorePort } from "@open-managed-agents/app/modules/deployment-runs";
import { dreamStorePort } from "@open-managed-agents/app/modules/dreams";
import {
  credentialStorePort,
  credentialValidationProbePort,
  credentialVaultSourcePort,
} from "@open-managed-agents/app/modules/credentials";
import { environmentStorePort } from "@open-managed-agents/app/modules/environments";
import { environmentWorkStorePort } from "@open-managed-agents/app/modules/environment-work";
import {
  fileContentStorePort,
  fileStorePort,
} from "@open-managed-agents/app/modules/files";
import { memoryStoreStorePort } from "@open-managed-agents/app/modules/memory-stores";
import { memoryDocumentStorePort } from "@open-managed-agents/app/modules/memories";
import { skillStorePort } from "@open-managed-agents/app/modules/skills";
import { tunnelStorePort } from "@open-managed-agents/app/modules/tunnels";
import { userProfileStorePort } from "@open-managed-agents/app/modules/user-profiles";
import {
  sessionEventStorePort,
  sessionWorkAdmissionPort,
} from "@open-managed-agents/app/modules/session-events";
import { sessionResourceStorePort } from "@open-managed-agents/app/modules/session-resources";
import { sessionThreadEventStorePort } from "@open-managed-agents/app/modules/session-thread-events";
import { sessionThreadStorePort } from "@open-managed-agents/app/modules/session-threads";
import {
  sessionCreateAdmissionPort,
  sessionStorePort,
} from "@open-managed-agents/app/modules/sessions";
import {
  credentialVaultSourceFromVaultStore,
  vaultStorePort,
} from "@open-managed-agents/app/modules/vaults";
import {
  admitAllSessionWork,
  SessionCreateAdmissionService,
  type CredentialValidationProbePort,
  type CredentialVaultSourcePort,
} from "@open-managed-agents/managed-agents-application";
import {
  resolveWorkspaceValue,
  WorkspaceAppRegistry,
  type WorkspaceScope,
  type WorkspaceValue,
} from "@open-managed-agents/platform";

/** Alias of `ControlPlaneStores` from `@openma/core/storage`. */
export type NodePlatformStores = ControlPlaneStores;

/**
 * Admission hooks. Every hook is optional; without one the control plane
 * admits the work. Denials carry their own HTTP status and body.
 */
export interface NodeAdmissionHooks {
  /** Consulted on Session create, after the rate limiter and daily counter. */
  sessionCreate?: SessionCreateAdmissionHookPort;
  sessionCreateRateLimiter?: SessionCreateRateLimiterPort;
  sessionCreateDailyCounter?: SessionCreateDailyCounterPort;
  /** Consulted before a new turn, thread start or hosted model request. */
  sessionWork?: SessionWorkAdmissionPort;
}

export interface NodeDefaultsOptions {
  workspaceId: string;
  /** Official application modules. Default: the `core` preset. */
  features?: ManagedAgentsFeatures | false;
  /** Stores to use; every store left out is an in-memory one. */
  stores?: Partial<ControlPlaneStores>;
  credentialVaults?: CredentialVaultSourcePort;
  credentialValidation?: CredentialValidationProbePort;
  fileContent?: FileContentStore;
  hooks?: NodeAdmissionHooks;
  clock?: ClockPort;
  ids?: IdGeneratorPort;
  http?: HttpClientPort;
  /** Extra modules, e.g. outbound Ports a non-default feature requires. */
  modules?: readonly AppModule[];
}

/**
 * The module list of one workspace's Node control plane: platform
 * capabilities, a store for every storage Port, admit-all admission hooks and
 * the official feature modules. Any value passed in replaces its default.
 *
 *   const app = createApp({ modules: nodeDefaults({ workspaceId, stores: { agents } }) });
 */
export function nodeDefaults(options: NodeDefaultsOptions): AppModule[] {
  const stores = memoryStores(options.stores);
  const clock = options.clock ?? systemClock;
  const hooks = options.hooks ?? {};
  return [
    providePort(workspaceContextPort, { workspaceId: options.workspaceId }),
    providePort(clockPort, clock),
    providePort(idGeneratorPort, options.ids ?? randomIds),
    providePort(httpClientPort, options.http ?? globalFetch),
    providePort(agentStorePort, stores.agents),
    providePort(credentialStorePort, stores.credentials),
    providePort(deploymentStorePort, stores.deployments),
    providePort(deploymentRunStorePort, stores.deploymentRuns),
    providePort(dreamStorePort, stores.dreams),
    providePort(
      credentialVaultSourcePort,
      options.credentialVaults ?? credentialVaultSourceFromVaultStore(stores.vaults),
    ),
    ...(options.credentialValidation === undefined
      ? []
      : [providePort(credentialValidationProbePort, options.credentialValidation)]),
    providePort(environmentStorePort, stores.environments),
    providePort(environmentWorkStorePort, stores.environmentWork),
    providePort(fileStorePort, stores.files),
    ...(options.fileContent === undefined
      ? []
      : [providePort(fileContentStorePort, options.fileContent)]),
    providePort(memoryStoreStorePort, stores.memoryStores),
    providePort(memoryDocumentStorePort, stores.memories),
    providePort(skillStorePort, stores.skills),
    providePort(tunnelStorePort, stores.tunnels),
    providePort(userProfileStorePort, stores.userProfiles),
    providePort(sessionStorePort, stores.sessions),
    providePort(sessionResourceStorePort, stores.sessionResources),
    providePort(sessionEventStorePort, stores.sessionEvents),
    providePort(sessionThreadStorePort, stores.sessionThreads),
    providePort(sessionThreadEventStorePort, stores.sessionEvents),
    providePort(vaultStorePort, stores.vaults),
    providePort(sessionCreateAdmissionPort, new SessionCreateAdmissionService({
      clock,
      ...(hooks.sessionCreate === undefined ? {} : { hook: hooks.sessionCreate }),
      ...(hooks.sessionCreateRateLimiter === undefined
        ? {}
        : { rateLimiter: hooks.sessionCreateRateLimiter }),
      ...(hooks.sessionCreateDailyCounter === undefined
        ? {}
        : { dailyCounter: hooks.sessionCreateDailyCounter }),
    })),
    providePort(sessionWorkAdmissionPort, hooks.sessionWork ?? admitAllSessionWork),
    ...(options.modules ?? []),
    ...managedAgentsFeatureModules(options.features),
  ];
}

export interface CreateNodePlatformOptions {
  /** Official application modules preinstalled for every workspace app. */
  features?: ManagedAgentsFeatures | false;
  stores?: WorkspaceValue<Partial<ControlPlaneStores>>;
  credentialVaults?: WorkspaceValue<CredentialVaultSourcePort>;
  credentialValidation?: WorkspaceValue<CredentialValidationProbePort>;
  fileContent?: WorkspaceValue<FileContentStore>;
  hooks?: WorkspaceValue<NodeAdmissionHooks>;
  clock?: ClockPort;
  ids?: IdGeneratorPort;
  http?: HttpClientPort;
  /** Called once for each workspace app so modules never carry workspace state across apps. */
  modules?(scope: WorkspaceScope): readonly AppModule[];
}

export interface NodePlatform {
  readonly apps: WorkspaceAppRegistry<App>;
  app(scope: WorkspaceScope): App;
  existing(workspaceId: string): App | undefined;
  stop(workspaceId: string): Promise<boolean>;
  stopAll(): Promise<void>;
}

/** One `nodeDefaults()` app graph per workspace, created on first use. */
export function createNodePlatform(
  options: CreateNodePlatformOptions = {},
): NodePlatform {
  // Stores given as a value (not per workspace) are shared by every workspace
  // app; they scope rows by workspaceId themselves.
  const sharedStores = options.stores === undefined
    || typeof options.stores !== "function"
    ? memoryStores(options.stores ?? {})
    : undefined;
  const optional = <Value>(
    value: WorkspaceValue<Value> | undefined,
    scope: WorkspaceScope,
  ): Value | undefined => value === undefined
    ? undefined
    : resolveWorkspaceValue(value, scope);
  const apps = new WorkspaceAppRegistry<App>({
    createApp(scope) {
      return createApp({
        modules: nodeDefaults({
          workspaceId: scope.workspaceId,
          features: options.features,
          stores: sharedStores ?? resolveWorkspaceValue(options.stores!, scope),
          credentialVaults: optional(options.credentialVaults, scope),
          credentialValidation: optional(options.credentialValidation, scope),
          fileContent: optional(options.fileContent, scope),
          hooks: optional(options.hooks, scope),
          clock: options.clock,
          ids: options.ids,
          http: options.http,
          modules: options.modules?.(scope),
        }),
      });
    },
  });
  return expose(apps);
}

export interface CreateNodeManagedAgentsAppOptions
  extends CreateNodePlatformOptions {
  workspaceId: string;
}

/** Creates one preconfigured app graph without exposing the workspace registry. */
export function createNodeManagedAgentsApp(
  options: CreateNodeManagedAgentsAppOptions,
): App {
  const { workspaceId, ...platformOptions } = options;
  return createNodePlatform(platformOptions).app({ workspaceId });
}

const systemClock: ClockPort = { now: () => new Date() };

const randomIds: IdGeneratorPort = {
  next: (namespace: string) => `${namespace}_${randomUuid()}`,
};

const globalFetch: HttpClientPort = {
  fetch: (input: string | Request, init?: RequestInit) =>
    globalThis.fetch(input, init),
};

function randomUuid(): string {
  const cryptoApi = (globalThis as typeof globalThis & {
    crypto?: { randomUUID(): string };
  }).crypto;
  if (cryptoApi === undefined) {
    throw new Error("The Node platform requires crypto.randomUUID or an ids Port");
  }
  return cryptoApi.randomUUID();
}

function expose(apps: WorkspaceAppRegistry<App>): NodePlatform {
  return {
    apps,
    app: apps.app.bind(apps),
    existing: apps.existing.bind(apps),
    stop: apps.stop.bind(apps),
    stopAll: apps.stopAll.bind(apps),
  };
}
