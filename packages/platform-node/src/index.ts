import type { AgentStore } from "@open-managed-agents/agent-store";
import { MemoryAgentStore } from "@open-managed-agents/agent-store-memory";
import {
  createApp,
  providePort,
  type App,
  type AppModule,
} from "@open-managed-agents/app";
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
import { sessionEventStorePort } from "@open-managed-agents/app/modules/session-events";
import { sessionResourceStorePort } from "@open-managed-agents/app/modules/session-resources";
import { sessionThreadEventStorePort } from "@open-managed-agents/app/modules/session-thread-events";
import { sessionThreadStorePort } from "@open-managed-agents/app/modules/session-threads";
import { sessionStorePort } from "@open-managed-agents/app/modules/sessions";
import {
  credentialVaultSourceFromVaultStore,
  vaultStorePort,
} from "@open-managed-agents/app/modules/vaults";
import {
  resolveWorkspaceValue,
  WorkspaceAppRegistry,
  type WorkspaceScope,
  type WorkspaceValue,
} from "@open-managed-agents/platform";
import type { SessionEventStore } from "@open-managed-agents/session-event-store";
import { MemorySessionEventStore } from "@open-managed-agents/session-event-store-memory";
import type { SessionStore } from "@open-managed-agents/session-store";
import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import type { SessionResourceStore } from "@open-managed-agents/session-resource-store";
import { MemorySessionResourceStore } from "@open-managed-agents/session-resource-store-memory";
import type { SessionThreadStore } from "@open-managed-agents/session-thread-store";
import { MemorySessionThreadStore } from "@open-managed-agents/session-thread-store-memory";
import type { EnvironmentStore } from "@open-managed-agents/environment-store";
import { MemoryEnvironmentStore } from "@open-managed-agents/environment-store-memory";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";
import { MemoryEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-memory";
import type { FileStore } from "@open-managed-agents/file-store";
import { MemoryFileStore } from "@open-managed-agents/file-store-memory";
import type { FileContentStore } from "@open-managed-agents/file-content-store";
import type { CredentialStore } from "@open-managed-agents/credential-store";
import { MemoryCredentialStore } from "@open-managed-agents/credential-store-memory";
import type { DeploymentStore } from "@open-managed-agents/deployment-store";
import { MemoryDeploymentStore } from "@open-managed-agents/deployment-store-memory";
import type { DeploymentRunStore } from "@open-managed-agents/deployment-run-store";
import { MemoryDeploymentRunStore } from "@open-managed-agents/deployment-run-store-memory";
import type { DreamStore } from "@open-managed-agents/dream-store";
import { MemoryDreamStore } from "@open-managed-agents/dream-store-memory";
import type { VaultStore } from "@open-managed-agents/vault-store";
import { MemoryVaultStore } from "@open-managed-agents/vault-store-memory";
import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";
import { InMemoryMemoryStoreStore } from "@open-managed-agents/memory-store-store-memory";
import type { MemoryDocumentStore } from "@open-managed-agents/memory-document-store";
import { InMemoryMemoryDocumentStore } from "@open-managed-agents/memory-document-store-memory";
import type { SkillStore } from "@open-managed-agents/skill-store";
import { MemorySkillStore } from "@open-managed-agents/skill-store-memory";
import type { TunnelStore } from "@open-managed-agents/tunnel-store";
import { MemoryTunnelStore } from "@open-managed-agents/tunnel-store-memory";
import type { UserProfileStore } from "@open-managed-agents/user-profile-store";
import { MemoryUserProfileStore } from "@open-managed-agents/user-profile-store-memory";
import type {
  CredentialValidationProbePort,
  CredentialVaultSourcePort,
} from "@open-managed-agents/managed-agents-application";

export interface NodePlatformStores {
  agents: AgentStore;
  credentials: CredentialStore;
  deployments: DeploymentStore;
  deploymentRuns: DeploymentRunStore;
  dreams: DreamStore;
  environments: EnvironmentStore;
  environmentWork: EnvironmentWorkStore;
  files: FileStore;
  memoryStores: MemoryStoreStore;
  memories: MemoryDocumentStore;
  skills: SkillStore;
  tunnels: TunnelStore;
  userProfiles: UserProfileStore;
  sessions: SessionStore;
  sessionResources: SessionResourceStore;
  sessionEvents: SessionEventStore;
  sessionThreads: SessionThreadStore;
  vaults: VaultStore;
}

export interface CreateNodePlatformOptions {
  stores?: WorkspaceValue<Partial<NodePlatformStores>>;
  credentialVaults?: WorkspaceValue<CredentialVaultSourcePort>;
  credentialValidation?: WorkspaceValue<CredentialValidationProbePort>;
  fileContent?: WorkspaceValue<FileContentStore>;
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

export function createNodePlatform(
  options: CreateNodePlatformOptions = {},
): NodePlatform {
  const sharedStores = options.stores === undefined
    || typeof options.stores !== "function"
    ? nodeStores(options.stores ?? {})
    : undefined;
  const clock = options.clock ?? { now: () => new Date() };
  const ids = options.ids ?? {
    next: (namespace: string) => `${namespace}_${randomUuid()}`,
  };
  const http = options.http ?? {
    fetch: (input: string | Request, init?: RequestInit) =>
      globalThis.fetch(input, init),
  };
  const apps = new WorkspaceAppRegistry<App>({
    createApp(scope) {
      const stores = sharedStores ?? nodeStores(
        resolveWorkspaceValue(options.stores!, scope),
      );
      const fileContent = options.fileContent === undefined
        ? undefined
        : resolveWorkspaceValue(options.fileContent, scope);
      const credentialVaults = options.credentialVaults === undefined
        ? credentialVaultSourceFromVaultStore(stores.vaults)
        : resolveWorkspaceValue(options.credentialVaults, scope);
      const credentialValidation = options.credentialValidation === undefined
        ? undefined
        : resolveWorkspaceValue(options.credentialValidation, scope);
      return createApp({
        modules: [
          providePort(workspaceContextPort, { workspaceId: scope.workspaceId }),
          providePort(clockPort, clock),
          providePort(idGeneratorPort, ids),
          providePort(httpClientPort, http),
          providePort(agentStorePort, stores.agents),
          providePort(credentialStorePort, stores.credentials),
          providePort(deploymentStorePort, stores.deployments),
          providePort(deploymentRunStorePort, stores.deploymentRuns),
          providePort(dreamStorePort, stores.dreams),
          providePort(credentialVaultSourcePort, credentialVaults),
          ...(credentialValidation === undefined
            ? []
            : [providePort(
                credentialValidationProbePort,
                credentialValidation,
              )]),
          providePort(environmentStorePort, stores.environments),
          providePort(environmentWorkStorePort, stores.environmentWork),
          providePort(fileStorePort, stores.files),
          ...(fileContent === undefined
            ? []
            : [providePort(fileContentStorePort, fileContent)]),
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
          ...(options.modules?.(scope) ?? []),
        ],
      });
    },
  });
  return expose(apps);
}

function nodeStores(overrides: Partial<NodePlatformStores>): NodePlatformStores {
  const sessions = overrides.sessions ?? new MemorySessionStore();
  const deployments = overrides.deployments ?? new MemoryDeploymentStore();
  return {
    agents: overrides.agents ?? new MemoryAgentStore(),
    credentials: overrides.credentials ?? new MemoryCredentialStore(),
    deployments,
    deploymentRuns: overrides.deploymentRuns
      ?? new MemoryDeploymentRunStore(deployments),
    dreams: overrides.dreams ?? new MemoryDreamStore(),
    environments: overrides.environments ?? new MemoryEnvironmentStore(),
    environmentWork: overrides.environmentWork ?? new MemoryEnvironmentWorkStore(),
    files: overrides.files ?? new MemoryFileStore(),
    memoryStores: overrides.memoryStores ?? new InMemoryMemoryStoreStore(),
    memories: overrides.memories ?? new InMemoryMemoryDocumentStore(),
    skills: overrides.skills ?? new MemorySkillStore(),
    tunnels: overrides.tunnels ?? new MemoryTunnelStore(),
    userProfiles: overrides.userProfiles ?? new MemoryUserProfileStore(),
    sessions,
    sessionResources: overrides.sessionResources
      ?? new MemorySessionResourceStore(sessions),
    sessionEvents: overrides.sessionEvents
      ?? new MemorySessionEventStore(sessions),
    sessionThreads: overrides.sessionThreads ?? new MemorySessionThreadStore(),
    vaults: overrides.vaults ?? new MemoryVaultStore(),
  };
}

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
