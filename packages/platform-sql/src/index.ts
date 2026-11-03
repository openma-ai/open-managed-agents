import { createApp, providePort, type App, type AppModule } from "@open-managed-agents/app";
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
import { fileContentStorePort, fileStorePort } from "@open-managed-agents/app/modules/files";
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
import { credentialVaultSourceFromVaultStore, vaultStorePort } from "@open-managed-agents/app/modules/vaults";
import {
  resolveWorkspaceValue,
  WorkspaceAppRegistry,
  type WorkspaceScope,
  type WorkspaceValue,
} from "@open-managed-agents/platform";
import type { ControlPlaneStores } from "@openma/core/storage";
import type { FileContentStore } from "@openma/core/storage/file-content";
import {
  sqlStores,
  type CredentialDocumentCipher,
  type DeploymentResourceSecretCipher,
  type EnvironmentWorkSecretCipher,
  type SessionResourceSecretSealer,
  type SqlClient,
} from "@openma/stores-sql";
import type {
  CredentialValidationProbePort,
  CredentialVaultSourcePort,
} from "@open-managed-agents/managed-agents-application";

export interface CreateSqlPlatformOptions {
  features?: ManagedAgentsFeatures | false;
  sql?: WorkspaceValue<SqlClient>;
  credentialCipher?: WorkspaceValue<CredentialDocumentCipher>;
  deploymentCipher?: WorkspaceValue<DeploymentResourceSecretCipher>;
  environmentWorkCipher?: WorkspaceValue<EnvironmentWorkSecretCipher>;
  credentialVaults?: WorkspaceValue<CredentialVaultSourcePort>;
  credentialValidation?: WorkspaceValue<CredentialValidationProbePort>;
  fileContent?: WorkspaceValue<FileContentStore>;
  sessionSecrets?: SessionResourceSecretSealer;
  stores?: WorkspaceValue<Partial<SqlPlatformStores>>;
  clock?: ClockPort;
  ids?: IdGeneratorPort;
  http?: HttpClientPort;
  modules?(scope: WorkspaceScope): readonly AppModule[];
}

/** Alias of `ControlPlaneStores` from `@openma/core/storage`. */
export type SqlPlatformStores = ControlPlaneStores;

export interface SqlWorkspaceScope extends WorkspaceScope {
  sql?: SqlClient;
  fileContent?: FileContentStore;
  credentialCipher?: CredentialDocumentCipher;
  deploymentCipher?: DeploymentResourceSecretCipher;
  environmentWorkCipher?: EnvironmentWorkSecretCipher;
  credentialVaults?: CredentialVaultSourcePort;
  credentialValidation?: CredentialValidationProbePort;
  modules?: readonly AppModule[];
}

export interface SqlPlatform {
  readonly apps: WorkspaceAppRegistry<App, SqlWorkspaceScope>;
  app(scope: SqlWorkspaceScope): App;
  existing(workspaceId: string): App | undefined;
  stop(workspaceId: string): Promise<boolean>;
  stopAll(): Promise<void>;
}

export function createSqlPlatform(options: CreateSqlPlatformOptions = {}): SqlPlatform {
  const clock = options.clock ?? { now: () => new Date() };
  const ids = options.ids ?? { next: (namespace: string) => `${namespace}_${randomUuid()}` };
  const http = options.http ?? {
    fetch: (input: string | Request, init?: RequestInit) => globalThis.fetch(input, init),
  };
  const apps = new WorkspaceAppRegistry<App, SqlWorkspaceScope>({
    createApp(scope) {
      const sql = scope.sql ?? (options.sql === undefined
        ? undefined
        : resolveWorkspaceValue(options.sql, scope));
      if (sql === undefined) {
        throw new TypeError("SQL workspace app requires sql in the platform options or workspace scope");
      }
      const overrides = options.stores === undefined ? {} : resolveWorkspaceValue(options.stores, scope);
      const credentialCipher = scope.credentialCipher
        ?? (options.credentialCipher === undefined
          ? undefined
          : resolveWorkspaceValue(options.credentialCipher, scope));
      const deploymentCipher = scope.deploymentCipher
        ?? (options.deploymentCipher === undefined
          ? undefined
          : resolveWorkspaceValue(options.deploymentCipher, scope));
      const environmentWorkCipher = scope.environmentWorkCipher
        ?? (options.environmentWorkCipher === undefined
          ? undefined
          : resolveWorkspaceValue(options.environmentWorkCipher, scope));
      const stores = sqlStores(sql, {
        credentialCipher,
        deploymentCipher,
        environmentWorkCipher,
        sessionSecrets: options.sessionSecrets,
        overrides,
      });
      const fileContent = scope.fileContent ?? (options.fileContent === undefined
        ? undefined
        : resolveWorkspaceValue(options.fileContent, scope));
      const credentialVaults = scope.credentialVaults
        ?? (options.credentialVaults === undefined
          ? credentialVaultSourceFromVaultStore(stores.vaults)
          : resolveWorkspaceValue(options.credentialVaults, scope));
      const credentialValidation = scope.credentialValidation
        ?? (options.credentialValidation === undefined
          ? undefined
          : resolveWorkspaceValue(options.credentialValidation, scope));
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
            : [providePort(credentialValidationProbePort, credentialValidation)]),
          providePort(environmentStorePort, stores.environments),
          providePort(environmentWorkStorePort, stores.environmentWork),
          providePort(fileStorePort, stores.files),
          ...(fileContent === undefined ? [] : [providePort(fileContentStorePort, fileContent)]),
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
          ...(scope.modules ?? []),
          ...(options.modules?.(scope) ?? []),
          ...managedAgentsFeatureModules(options.features),
        ],
      });
    },
  });
  return {
    apps,
    app: apps.app.bind(apps),
    existing: apps.existing.bind(apps),
    stop: apps.stop.bind(apps),
    stopAll: apps.stopAll.bind(apps),
  };
}

export function createSqlManagedAgentsApp(
  scope: SqlWorkspaceScope,
  options: CreateSqlPlatformOptions = {},
): App {
  return createSqlPlatform(options).app(scope);
}

function randomUuid(): string {
  const cryptoApi = (globalThis as typeof globalThis & { crypto?: { randomUUID(): string } }).crypto;
  if (cryptoApi === undefined) throw new Error("The SQL platform requires crypto.randomUUID or an ids Port");
  return cryptoApi.randomUUID();
}
