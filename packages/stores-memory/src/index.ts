// @openma/stores-memory: in-memory adapters for every @openma/core storage
// Port (ADR 0015). State lives in the process and is lost on restart.
import type { ControlPlaneStores } from "@openma/core/storage";
import { MemoryAgentStore } from "@open-managed-agents/agent-store-memory";
import { MemoryCredentialStore } from "@open-managed-agents/credential-store-memory";
import { MemoryDeploymentRunStore } from "@open-managed-agents/deployment-run-store-memory";
import { MemoryDeploymentStore } from "@open-managed-agents/deployment-store-memory";
import { MemoryDreamStore } from "@open-managed-agents/dream-store-memory";
import { MemoryEnvironmentStore } from "@open-managed-agents/environment-store-memory";
import { MemoryEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-memory";
import { MemoryFileStore } from "@open-managed-agents/file-store-memory";
import { InMemoryMemoryDocumentStore } from "@open-managed-agents/memory-document-store-memory";
import { InMemoryMemoryStoreStore } from "@open-managed-agents/memory-store-store-memory";
import { MemorySessionEventStore } from "@open-managed-agents/session-event-store-memory";
import { MemorySessionResourceStore } from "@open-managed-agents/session-resource-store-memory";
import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import { MemorySessionThreadStore } from "@open-managed-agents/session-thread-store-memory";
import { MemorySkillStore } from "@open-managed-agents/skill-store-memory";
import { MemoryTunnelStore } from "@open-managed-agents/tunnel-store-memory";
import { MemoryUserProfileStore } from "@open-managed-agents/user-profile-store-memory";
import { MemoryVaultStore } from "@open-managed-agents/vault-store-memory";

export type { ControlPlaneStores } from "@openma/core/storage";

export {
  InMemoryMemoryDocumentStore,
  InMemoryMemoryStoreStore,
  MemoryAgentStore,
  MemoryCredentialStore,
  MemoryDeploymentRunStore,
  MemoryDeploymentStore,
  MemoryDreamStore,
  MemoryEnvironmentStore,
  MemoryEnvironmentWorkStore,
  MemoryFileStore,
  MemorySessionEventStore,
  MemorySessionResourceStore,
  MemorySessionStore,
  MemorySessionThreadStore,
  MemorySkillStore,
  MemoryTunnelStore,
  MemoryUserProfileStore,
  MemoryVaultStore,
};

/**
 * A complete in-memory store set. Stores that read another store (Session
 * resources and events read Sessions; Deployment runs read Deployments) are
 * wired to the store passed in `overrides` when there is one.
 */
export function memoryStores(
  overrides: Partial<ControlPlaneStores> = {},
): ControlPlaneStores {
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
