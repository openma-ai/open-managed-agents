// Storage (persistence) Ports implemented by store adapters. A custom store
// implements one of these interfaces; `ControlPlaneStores` is the complete set
// a Node control plane binds (see @openma/server `nodeDefaults()`).
import type { AgentStore } from "./agents.js";
import type { CredentialStore } from "./credentials.js";
import type { DeploymentRunStore } from "./deployment-runs.js";
import type { DeploymentStore } from "./deployments.js";
import type { DreamStore } from "./dreams.js";
import type { EnvironmentWorkStore } from "./environment-work.js";
import type { EnvironmentStore } from "./environments.js";
import type { FileStore } from "./files.js";
import type { MemoryDocumentStore } from "./memories.js";
import type { MemoryStoreStore } from "./memory-stores.js";
import type { SessionEventStore } from "./session-events.js";
import type { SessionResourceStore } from "./session-resources.js";
import type { SessionThreadStore } from "./session-threads.js";
import type { SessionStore } from "./sessions.js";
import type { SkillStore } from "./skills.js";
import type { TunnelStore } from "./tunnels.js";
import type { UserProfileStore } from "./user-profiles.js";
import type { VaultStore } from "./vaults.js";

export type * from "./agents.js";
export type * from "./credentials.js";
export type * from "./deployment-runs.js";
export type * from "./deployments.js";
export type * from "./dreams.js";
export type * from "./environment-work.js";
export type * from "./environments.js";
export type * from "./file-content.js";
export type * from "./files.js";
export type * from "./memories.js";
export type * from "./memory-stores.js";
export type * from "./session-events.js";
export type * from "./session-resources.js";
export type * from "./session-threads.js";
export type * from "./sessions.js";
export type * from "./skills.js";
export type * from "./tunnels.js";
export type * from "./user-profiles.js";
export type * from "./vaults.js";

/**
 * Every storage Port a control plane binds, keyed by resource. File bytes are
 * not part of it: `FileContentStore` is optional and bound separately.
 */
export interface ControlPlaneStores {
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
  /** Also bound as the Session thread event store. */
  sessionEvents: SessionEventStore;
  sessionThreads: SessionThreadStore;
  vaults: VaultStore;
}
