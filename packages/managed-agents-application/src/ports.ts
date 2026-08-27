// Composition root for application-facing ports consumed by the HTTP adapter.
// Wire DTOs, vendor SDK types, validation libraries, and HTTP concepts must not
// cross this boundary.

import type { AgentsApplicationPort } from "./ports/agents";
import type { CredentialsApplicationPort } from "./ports/credentials";
import type { DeploymentRunsApplicationPort } from "./ports/deployment-runs";
import type { DeploymentsApplicationPort } from "./ports/deployments";
import type { DreamsApplicationPort } from "./ports/dreams";
import type { EnvironmentsApplicationPort } from "./ports/environments";
import type { EnvironmentWorkApplicationPort } from "./ports/environment-work";
import type { FilesApplicationPort } from "./ports/files";
import type { MemoriesApplicationPort } from "./ports/memories";
import type { MemoryStoresApplicationPort } from "./ports/memory-stores";
import type { MemoryVersionsApplicationPort } from "./ports/memory-versions";
import type { ModelsApplicationPort } from "./ports/models";
import type { SessionEventsApplicationPort } from "./ports/session-events";
import type { SessionResourcesApplicationPort } from "./ports/session-resources";
import type { SessionThreadEventsApplicationPort } from "./ports/session-thread-events";
import type { SessionThreadsApplicationPort } from "./ports/session-threads";
import type { SessionsApplicationPort } from "./ports/sessions";
import type { SkillVersionsApplicationPort } from "./ports/skill-versions";
import type { SkillsApplicationPort } from "./ports/skills";
import type { TunnelCertificatesApplicationPort } from "./ports/tunnel-certificates";
import type { TunnelsApplicationPort } from "./ports/tunnels";
import type { UserProfilesApplicationPort } from "./ports/user-profiles";
import type { VaultsApplicationPort } from "./ports/vaults";

export * from "./ports/agents";
export * from "./ports/common";
export * from "./ports/credentials";
export * from "./ports/deployment-runs";
export * from "./ports/deployments";
export * from "./ports/dreams";
export * from "./ports/environments";
export * from "./ports/environment-work";
export * from "./ports/files";
export * from "./ports/memories";
export * from "./ports/memory-stores";
export * from "./ports/memory-versions";
export * from "./ports/models";
export * from "./ports/session-events";
export * from "./ports/session-resources";
export * from "./ports/session-thread-events";
export * from "./ports/session-threads";
export * from "./ports/sessions";
export * from "./ports/skill-versions";
export * from "./ports/skills";
export * from "./ports/tunnel-certificates";
export * from "./ports/tunnels";
export * from "./ports/user-profiles";
export * from "./ports/vaults";

export interface ManagedAgentsApplicationPorts {
  agents: AgentsApplicationPort;
  credentials: CredentialsApplicationPort;
  deploymentRuns: DeploymentRunsApplicationPort;
  deployments: DeploymentsApplicationPort;
  dreams: DreamsApplicationPort;
  environments: EnvironmentsApplicationPort;
  environmentWork: EnvironmentWorkApplicationPort;
  files: FilesApplicationPort;
  memories: MemoriesApplicationPort;
  memoryStores: MemoryStoresApplicationPort;
  memoryVersions: MemoryVersionsApplicationPort;
  models: ModelsApplicationPort;
  sessionEvents: SessionEventsApplicationPort;
  sessionResources: SessionResourcesApplicationPort;
  sessionThreadEvents: SessionThreadEventsApplicationPort;
  sessionThreads: SessionThreadsApplicationPort;
  sessions: SessionsApplicationPort;
  skillVersions: SkillVersionsApplicationPort;
  skills: SkillsApplicationPort;
  tunnelCertificates: TunnelCertificatesApplicationPort;
  tunnels: TunnelsApplicationPort;
  userProfiles: UserProfilesApplicationPort;
  vaults: VaultsApplicationPort;
}
