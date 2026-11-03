// Composition root for application-facing ports consumed by the HTTP adapter.
// Wire DTOs, vendor SDK types, validation libraries, and HTTP concepts must not
// cross this boundary.

import type { AgentsApplicationPort } from "./ports/agents.js";
import type { CredentialsApplicationPort } from "./ports/credentials.js";
import type { DeploymentRunsApplicationPort } from "./ports/deployment-runs.js";
import type { DeploymentsApplicationPort } from "./ports/deployments.js";
import type { DreamsApplicationPort } from "./ports/dreams.js";
import type { EnvironmentsApplicationPort } from "./ports/environments.js";
import type { EnvironmentWorkApplicationPort } from "./ports/environment-work.js";
import type { FilesApplicationPort } from "./ports/files.js";
import type { MemoriesApplicationPort } from "./ports/memories.js";
import type { MemoryStoresApplicationPort } from "./ports/memory-stores.js";
import type { MemoryVersionsApplicationPort } from "./ports/memory-versions.js";
import type { ModelsApplicationPort } from "./ports/models.js";
import type { SessionEventsApplicationPort } from "./ports/session-events.js";
import type { SessionResourcesApplicationPort } from "./ports/session-resources.js";
import type { SessionThreadEventsApplicationPort } from "./ports/session-thread-events.js";
import type { SessionThreadsApplicationPort } from "./ports/session-threads.js";
import type { SessionsApplicationPort } from "./ports/sessions.js";
import type { SkillVersionsApplicationPort } from "./ports/skill-versions.js";
import type { SkillsApplicationPort } from "./ports/skills.js";
import type { TunnelCertificatesApplicationPort } from "./ports/tunnel-certificates.js";
import type { TunnelsApplicationPort } from "./ports/tunnels.js";
import type { UserProfilesApplicationPort } from "./ports/user-profiles.js";
import type { VaultsApplicationPort } from "./ports/vaults.js";

export type * from "./ports/agents.js";
export type * from "./ports/common.js";
export type * from "./ports/credentials.js";
export type * from "./ports/deployment-runs.js";
export type * from "./ports/deployments.js";
export type * from "./ports/dreams.js";
export type * from "./ports/environments.js";
export type * from "./ports/environment-work.js";
export type * from "./ports/files.js";
export type * from "./ports/memories.js";
export type * from "./ports/memory-stores.js";
export type * from "./ports/memory-versions.js";
export type * from "./ports/models.js";
export type * from "./ports/session-events.js";
export type * from "./ports/session-resources.js";
export type * from "./ports/session-thread-events.js";
export type * from "./ports/session-threads.js";
export type * from "./ports/sessions.js";
export type * from "./ports/skill-versions.js";
export type * from "./ports/skills.js";
export type * from "./ports/tunnel-certificates.js";
export type * from "./ports/tunnels.js";
export type * from "./ports/user-profiles.js";
export type * from "./ports/vaults.js";

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
