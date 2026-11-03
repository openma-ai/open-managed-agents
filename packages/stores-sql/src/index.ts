// @openma/stores-sql: SQL adapters for every @openma/core storage Port
// (ADR 0015). Stores talk to a driver-neutral `SqlClient`; the Node driver
// factories load better-sqlite3, postgres or mysql2 (optional peers) lazily.
// The adapters expect the OpenMA control-plane schema to exist already.
import type { ControlPlaneStores } from "@openma/core/storage";
import { SqlAgentStore } from "@open-managed-agents/agent-store-sql";
import {
  SqlCredentialStore,
  type CredentialDocumentCipher,
} from "@open-managed-agents/credential-store-sql";
import { SqlDeploymentRunStore } from "@open-managed-agents/deployment-run-store-sql";
import {
  SqlDeploymentStore,
  type DeploymentResourceSecretCipher,
} from "@open-managed-agents/deployment-store-sql";
import { SqlDreamStore } from "@open-managed-agents/dream-store-sql";
import { SqlEnvironmentStore } from "@open-managed-agents/environment-store-sql";
import {
  SqlEnvironmentWorkStore,
  type EnvironmentWorkSecretCipher,
} from "@open-managed-agents/environment-work-store-sql";
import { SqlFileStore } from "@open-managed-agents/file-store-sql";
import { SqlMemoryDocumentStore } from "@open-managed-agents/memory-document-store-sql";
import { SqlMemoryStoreStore } from "@open-managed-agents/memory-store-store-sql";
import { SqlSessionEventStore } from "@open-managed-agents/session-event-store-sql";
import { SqlSessionResourceStore } from "@open-managed-agents/session-resource-store-sql";
import {
  SqlSessionStore,
  type SessionResourceSecretSealer,
} from "@open-managed-agents/session-store-sql";
import { SqlSessionThreadStore } from "@open-managed-agents/session-thread-store-sql";
import { SqlSkillStore } from "@open-managed-agents/skill-store-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlTunnelStore } from "@open-managed-agents/tunnel-store-sql";
import { SqlUserProfileStore } from "@open-managed-agents/user-profile-store-sql";
import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";

export type { ControlPlaneStores } from "@openma/core/storage";
export type {
  SqlClient,
  SqlExecMeta,
  SqlRunResult,
  SqlSelectResult,
  SqlStatement,
} from "@open-managed-agents/sql-client";
export {
  createBetterSqlite3SqlClient,
  createMysql2SqlClient,
  createPostgresSqlClient,
  type Mysql2SqlClientOptions,
} from "@open-managed-agents/sql-client";
export type { CredentialDocumentCipher } from "@open-managed-agents/credential-store-sql";
export type { DeploymentResourceSecretCipher } from "@open-managed-agents/deployment-store-sql";
export type { EnvironmentWorkSecretCipher } from "@open-managed-agents/environment-work-store-sql";
export type { SessionResourceSecretSealer } from "@open-managed-agents/session-store-sql";

export {
  SqlAgentStore,
  SqlCredentialStore,
  SqlDeploymentRunStore,
  SqlDeploymentStore,
  SqlDreamStore,
  SqlEnvironmentStore,
  SqlEnvironmentWorkStore,
  SqlFileStore,
  SqlMemoryDocumentStore,
  SqlMemoryStoreStore,
  SqlSessionEventStore,
  SqlSessionResourceStore,
  SqlSessionStore,
  SqlSessionThreadStore,
  SqlSkillStore,
  SqlTunnelStore,
  SqlUserProfileStore,
  SqlVaultStore,
};

export interface SqlStoresOptions {
  /** Seals Credential auth documents at rest. Required to write Credentials. */
  credentialCipher?: CredentialDocumentCipher;
  /** Seals Deployment resource secrets. Required to write Deployments that carry them. */
  deploymentCipher?: DeploymentResourceSecretCipher;
  /** Seals Environment Work bearer secrets. Required to enqueue Work. */
  environmentWorkCipher?: EnvironmentWorkSecretCipher;
  /** Seals Session resource secrets. Required to persist Sessions with them. */
  sessionSecrets?: SessionResourceSecretSealer;
  /** Stores to use instead of the SQL ones. */
  overrides?: Partial<ControlPlaneStores>;
}

/**
 * A complete SQL store set over one `SqlClient`. A missing cipher or sealer
 * fails closed: the affected write rejects instead of storing plaintext.
 */
export function sqlStores(
  sql: SqlClient,
  options: SqlStoresOptions = {},
): ControlPlaneStores {
  const overrides = options.overrides ?? {};
  const sessionSecrets = options.sessionSecrets ?? unavailableSessionSecrets;
  return {
    agents: overrides.agents ?? new SqlAgentStore(sql),
    credentials: overrides.credentials
      ?? new SqlCredentialStore(sql, options.credentialCipher ?? unavailableCipher("Credential", "credentialCipher")),
    deployments: overrides.deployments
      ?? new SqlDeploymentStore(sql, options.deploymentCipher ?? unavailableCipher("Deployment", "deploymentCipher")),
    deploymentRuns: overrides.deploymentRuns ?? new SqlDeploymentRunStore(sql),
    dreams: overrides.dreams ?? new SqlDreamStore(sql),
    environments: overrides.environments ?? new SqlEnvironmentStore(sql),
    environmentWork: overrides.environmentWork
      ?? new SqlEnvironmentWorkStore(sql, options.environmentWorkCipher ?? unavailableCipher("Environment Work", "environmentWorkCipher")),
    files: overrides.files ?? new SqlFileStore(sql),
    memoryStores: overrides.memoryStores ?? new SqlMemoryStoreStore(sql),
    memories: overrides.memories ?? new SqlMemoryDocumentStore(sql),
    skills: overrides.skills ?? new SqlSkillStore(sql),
    tunnels: overrides.tunnels ?? new SqlTunnelStore(sql),
    userProfiles: overrides.userProfiles ?? new SqlUserProfileStore(sql),
    sessions: overrides.sessions ?? new SqlSessionStore(sql, sessionSecrets),
    sessionResources: overrides.sessionResources
      ?? new SqlSessionResourceStore(sql, sessionSecrets),
    sessionEvents: overrides.sessionEvents ?? new SqlSessionEventStore(sql),
    sessionThreads: overrides.sessionThreads ?? new SqlSessionThreadStore(sql),
    vaults: overrides.vaults ?? new SqlVaultStore(sql),
  };
}

const unavailableSessionSecrets: SessionResourceSecretSealer = {
  seal: async (): Promise<string> => {
    throw new Error("SQL Session persistence requires a sessionSecrets sealer");
  },
};

// The three document ciphers share one shape.
function unavailableCipher(
  resource: string,
  option: string,
): CredentialDocumentCipher & DeploymentResourceSecretCipher & EnvironmentWorkSecretCipher {
  const fail = async (): Promise<never> => {
    throw new Error(`SQL ${resource} persistence requires a ${option}`);
  };
  return { seal: fail, open: fail };
}
