import { describe, expect, it } from "vitest";
import type { AgentStore } from "@open-managed-agents/agent-store";
import type { CredentialStore } from "@open-managed-agents/credential-store";
import type { DeploymentStore } from "@open-managed-agents/deployment-store";
import type { DeploymentRunStore } from "@open-managed-agents/deployment-run-store";
import type { DreamStore } from "@open-managed-agents/dream-store";
import type { EnvironmentStore } from "@open-managed-agents/environment-store";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";
import type { FileStore } from "@open-managed-agents/file-store";
import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";
import type { MemoryDocumentStore } from "@open-managed-agents/memory-document-store";
import type { SessionEventLogStore } from "@open-managed-agents/session-event-store";
import type { SessionStore } from "@open-managed-agents/session-store";
import type { SkillStore } from "@open-managed-agents/skill-store";
import type { TunnelStore } from "@open-managed-agents/tunnel-store";
import type { UserProfileStore } from "@open-managed-agents/user-profile-store";
import type { VaultStore } from "@open-managed-agents/vault-store";
import { createApp } from "@open-managed-agents/app";
import { agentStorePort } from "@open-managed-agents/app/modules/agents";
import { credentialStorePort } from "@open-managed-agents/app/modules/credentials";
import { deploymentStorePort } from "@open-managed-agents/app/modules/deployments";
import { deploymentRunStorePort } from "@open-managed-agents/app/modules/deployment-runs";
import { dreamStorePort } from "@open-managed-agents/app/modules/dreams";
import { environmentStorePort } from "@open-managed-agents/app/modules/environments";
import { environmentWorkStorePort } from "@open-managed-agents/app/modules/environment-work";
import { fileStorePort } from "@open-managed-agents/app/modules/files";
import { memoryStoreStorePort } from "@open-managed-agents/app/modules/memory-stores";
import { memoryDocumentStorePort } from "@open-managed-agents/app/modules/memories";
import { sessionEventStorePort } from "@open-managed-agents/app/modules/session-events";
import { sessionStorePort } from "@open-managed-agents/app/modules/sessions";
import { skillStorePort } from "@open-managed-agents/app/modules/skills";
import { tunnelStorePort } from "@open-managed-agents/app/modules/tunnels";
import { userProfileStorePort } from "@open-managed-agents/app/modules/user-profiles";
import { vaultStorePort } from "@open-managed-agents/app/modules/vaults";
import {
  agentStoreFromV0,
  agentsDependenciesFromV0,
  credentialStoreFromV0,
  credentialsDependenciesFromV0,
  deploymentStoreFromV0,
  deploymentsDependenciesFromV0,
  deploymentRunStoreFromV0,
  deploymentRunsDependenciesFromV0,
  dreamStoreFromV0,
  dreamExecutionDependenciesFromV0,
  dreamsDependenciesFromV0,
  environmentStoreFromV0,
  environmentsDependenciesFromV0,
  environmentWorkStoreFromV0,
  environmentWorkDependenciesFromV0,
  environmentWorkEnqueuerDependenciesFromV0,
  fileStoreFromV0,
  filesDependenciesFromV0,
  memoryStoreStoreFromV0,
  memoryStoresDependenciesFromV0,
  memoryDocumentStoreFromV0,
  memoriesDependenciesFromV0,
  memoryVersionsDependenciesFromV0,
  sessionEventStoreFromV0,
  sessionStoreFromV0,
  sessionsDependenciesFromV0,
  skillStoreFromV0,
  skillsDependenciesFromV0,
  skillVersionsDependenciesFromV0,
  tunnelStoreFromV0,
  tunnelsDependenciesFromV0,
  tunnelCertificatesDependenciesFromV0,
  userProfileStoreFromV0,
  userProfilesDependenciesFromV0,
  vaultStoreFromV0,
  vaultsDependenciesFromV0,
  v0AgentPersistenceModule,
  v0CredentialPersistenceModule,
  v0DeploymentPersistenceModule,
  v0DeploymentRunPersistenceModule,
  v0DreamPersistenceModule,
  v0EnvironmentPersistenceModule,
  v0EnvironmentWorkPersistenceModule,
  v0FilePersistenceModule,
  v0MemoryStorePersistenceModule,
  v0MemoryPersistenceModule,
  v0SessionEventPersistenceModule,
  v0SessionPersistenceModule,
  v0SkillPersistenceModule,
  v0TunnelPersistenceModule,
  v0UserProfilePersistenceModule,
  v0VaultPersistenceModule,
} from "../src/index";

const agentPersistence = {
  insert: async (input) => input.agent,
  findCurrent: async () => null,
  findVersion: async () => null,
  replaceCurrent: async () => ({ type: "not_found" as const }),
  archiveCurrent: async () => ({ type: "not_found" as const }),
  listCurrent: async () => [],
  listVersions: async () => [],
} satisfies AgentStore;

const environmentPersistence = {
  insert: async (input) => ({ environment: input.environment, revision: 1 }),
  find: async () => null,
  replace: async () => ({ type: "not_found" as const }),
  archive: async () => ({ type: "not_found" as const }),
  delete: async () => ({ type: "not_found" as const }),
  list: async () => [],
} satisfies EnvironmentStore;

const environmentWorkPersistence = {
  insert: async (input) => ({ ...input.record, revision: 1 }),
  find: async () => null,
  findActiveSession: async () => null,
  list: async () => [],
  replace: async () => ({ type: "not_found" as const }),
  claimAvailable: async () => ({ type: "empty" as const }),
  queueStats: async () => ({
    depth: 0,
    oldestQueuedAt: null,
    pending: 0,
    workersPolling: null,
  }),
} satisfies EnvironmentWorkStore;

const credentialPersistence = {
  insert: async (input) => ({ credential: input.credential, revision: 1 }),
  find: async () => null,
  replace: async () => ({ type: "not_found" as const }),
  archive: async () => ({ type: "not_found" as const }),
  delete: async () => ({ type: "not_found" as const }),
  list: async () => [],
} satisfies CredentialStore;

const deploymentPersistence = {
  insert: async (input) => ({ ...input.record, revision: 1 }),
  find: async () => null,
  replace: async () => ({ type: "not_found" as const }),
  list: async () => [],
} satisfies DeploymentStore;

const deploymentRunPersistence = {
  beginManual: async () => ({ type: "not_found" as const }),
  finalize: async () => ({ type: "not_found" as const }),
  find: async () => null,
  list: async () => [],
} satisfies DeploymentRunStore;

const dreamPersistence = {
  insert: async (input) => ({ dream: input.dream, revision: 1 }),
  find: async () => null,
  list: async () => [],
  replace: async () => ({ type: "not_found" as const }),
} satisfies DreamStore;

const filePersistence = {
  insert: async (input) => input.file,
  find: async () => null,
  list: async () => [],
  delete: async () => ({ type: "not_found" as const }),
} satisfies FileStore;

const memoryStorePersistence = {
  insert: async (input) => ({ memoryStore: input.memoryStore, revision: 1 }),
  find: async () => null,
  replace: async () => ({ type: "not_found" as const }),
  archive: async () => ({ type: "not_found" as const }),
  delete: async () => ({ type: "not_found" as const }),
  list: async () => [],
} satisfies MemoryStoreStore;

const memoryPersistence = {
  create: async (input) => ({
    type: "created" as const,
    memory: { memory: input.memory, revision: 1 },
    version: { version: input.version, revision: 1 },
  }),
  findCurrent: async () => null,
  replace: async () => ({ type: "not_found" as const }),
  delete: async () => ({ type: "not_found" as const }),
  listCurrent: async () => ({ items: [], hasMore: false }),
  findVersion: async () => null,
  listVersions: async () => [],
  redactVersion: async () => ({ type: "not_found" as const }),
} satisfies MemoryDocumentStore;

const sessionPersistence = {
  insert: async (input) => ({ session: input.session, revision: 1 }),
  findCurrent: async () => null,
  replaceCurrent: async () => ({ type: "not_found" as const }),
  archiveCurrent: async () => ({ type: "not_found" as const }),
  deleteCurrent: async () => ({ type: "not_found" as const }),
  listCurrent: async () => [],
} satisfies SessionStore;

const sessionEventPersistence = {
  append: async (input) => ({
    type: "appended" as const,
    events: input.events,
    session: input.nextSession,
  }),
  list: async () => [],
} satisfies SessionEventLogStore;

const skillPersistence = {
  insertWithInitialVersion: async (input) => ({
    skill: { skill: input.skill, revision: 1 },
    version: { version: input.version, archive: input.archive },
  }),
  findSkill: async () => null,
  listSkills: async () => [],
  deleteSkill: async () => ({ type: "not_found" as const }),
  findVersion: async () => null,
  listVersions: async () => [],
  appendVersion: async () => ({ type: "not_found" as const }),
  findLatestVersionExcluding: async () => null,
  deleteVersion: async () => ({ type: "not_found" as const }),
} satisfies SkillStore;

const tunnelPersistence = {
  insert: async (input) => ({ aggregate: input.aggregate, revision: 1 }),
  find: async () => null,
  list: async () => [],
  replace: async () => ({ type: "not_found" as const }),
} satisfies TunnelStore;

const userProfilePersistence = {
  insert: async (input) => ({ profile: input.profile, revision: 1 }),
  find: async () => null,
  replace: async () => ({ type: "not_found" as const }),
  list: async () => [],
} satisfies UserProfileStore;

const vaultPersistence = {
  insert: async (input) => ({ vault: input.vault, revision: 1 }),
  find: async () => null,
  replace: async () => ({ type: "not_found" as const }),
  archive: async () => ({ type: "not_found" as const }),
  delete: async () => ({ type: "not_found" as const }),
  list: async () => [],
} satisfies VaultStore;

describe("v0 Store compatibility", () => {
  it("adapts old structural persistence implementations without copying", () => {
    expect(agentStoreFromV0(agentPersistence)).toBe(agentPersistence);
    expect(credentialStoreFromV0(credentialPersistence)).toBe(
      credentialPersistence,
    );
    expect(deploymentStoreFromV0(deploymentPersistence)).toBe(
      deploymentPersistence,
    );
    expect(deploymentRunStoreFromV0(deploymentRunPersistence)).toBe(
      deploymentRunPersistence,
    );
    expect(dreamStoreFromV0(dreamPersistence)).toBe(dreamPersistence);
    expect(environmentStoreFromV0(environmentPersistence)).toBe(
      environmentPersistence,
    );
    expect(environmentWorkStoreFromV0(environmentWorkPersistence)).toBe(
      environmentWorkPersistence,
    );
    expect(fileStoreFromV0(filePersistence)).toBe(filePersistence);
    expect(memoryStoreStoreFromV0(memoryStorePersistence)).toBe(
      memoryStorePersistence,
    );
    expect(memoryDocumentStoreFromV0(memoryPersistence)).toBe(
      memoryPersistence,
    );
    expect(sessionEventStoreFromV0(sessionEventPersistence)).toBe(
      sessionEventPersistence,
    );
    expect(sessionStoreFromV0(sessionPersistence)).toBe(sessionPersistence);
    expect(skillStoreFromV0(skillPersistence)).toBe(skillPersistence);
    expect(tunnelStoreFromV0(tunnelPersistence)).toBe(tunnelPersistence);
    expect(userProfileStoreFromV0(userProfilePersistence)).toBe(
      userProfilePersistence,
    );
    expect(vaultStoreFromV0(vaultPersistence)).toBe(vaultPersistence);
  });

  it("installs old persistence implementations as v1 app modules", () => {
    const app = createApp({
      modules: [
        v0AgentPersistenceModule(agentPersistence),
        v0CredentialPersistenceModule(credentialPersistence),
        v0DeploymentPersistenceModule(deploymentPersistence),
        v0DeploymentRunPersistenceModule(deploymentRunPersistence),
        v0DreamPersistenceModule(dreamPersistence),
        v0EnvironmentPersistenceModule(environmentPersistence),
        v0EnvironmentWorkPersistenceModule(environmentWorkPersistence),
        v0FilePersistenceModule(filePersistence),
        v0MemoryStorePersistenceModule(memoryStorePersistence),
        v0MemoryPersistenceModule(memoryPersistence),
        v0SessionEventPersistenceModule(sessionEventPersistence),
        v0SessionPersistenceModule(sessionPersistence),
        v0SkillPersistenceModule(skillPersistence),
        v0TunnelPersistenceModule(tunnelPersistence),
        v0UserProfilePersistenceModule(userProfilePersistence),
        v0VaultPersistenceModule(vaultPersistence),
      ],
    });
    expect(app.port(agentStorePort)).toBe(agentPersistence);
    expect(app.port(credentialStorePort)).toBe(credentialPersistence);
    expect(app.port(deploymentStorePort)).toBe(deploymentPersistence);
    expect(app.port(deploymentRunStorePort)).toBe(deploymentRunPersistence);
    expect(app.port(dreamStorePort)).toBe(dreamPersistence);
    expect(app.port(environmentStorePort)).toBe(environmentPersistence);
    expect(app.port(environmentWorkStorePort)).toBe(environmentWorkPersistence);
    expect(app.port(fileStorePort)).toBe(filePersistence);
    expect(app.port(memoryStoreStorePort)).toBe(memoryStorePersistence);
    expect(app.port(memoryDocumentStorePort)).toBe(memoryPersistence);
    expect(app.port(sessionEventStorePort)).toBe(sessionEventPersistence);
    expect(app.port(sessionStorePort)).toBe(sessionPersistence);
    expect(app.port(skillStorePort)).toBe(skillPersistence);
    expect(app.port(tunnelStorePort)).toBe(tunnelPersistence);
    expect(app.port(userProfileStorePort)).toBe(userProfilePersistence);
    expect(app.port(vaultStorePort)).toBe(vaultPersistence);
  });

  it("mechanically adapts direct service constructors", () => {
    const agentDependencies = agentsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: agentPersistence,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextAgentId: () => "agent_01" },
    });
    const credentialDependencies = credentialsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: credentialPersistence,
      vaults: { find: async () => null },
      validation: {
        validate: async () => ({
          hasRefreshToken: false,
          mcpProbe: null,
          refresh: null,
          status: "indeterminate" as const,
        }),
      },
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextCredentialId: () => "vcrd_01" },
    });
    const deploymentDependencies = deploymentsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: deploymentPersistence,
      agents: {} as never,
      environments: {} as never,
      files: {} as never,
      memoryStores: {} as never,
      runs: {} as never,
      schedules: {} as never,
      sessions: {} as never,
      vaults: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: {
        nextDeploymentId: () => "depl_01",
        nextDeploymentRunId: () => "drun_01",
      },
    });
    const deploymentRunDependencies = deploymentRunsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: deploymentRunPersistence,
    });
    const dreamDependencies = dreamsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: dreamPersistence,
      memoryStores: {} as never,
      sessions: {} as never,
      execution: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextDreamId: () => "dream_01" },
    });
    const dreamExecutionDependencies = dreamExecutionDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: dreamPersistence,
      memories: {} as never,
      curator: {} as never,
      sessions: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
    });
    const sessionDependencies = sessionsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: sessionPersistence,
      agents: {
        findCurrent: async () => null,
        findVersion: async () => null,
      },
      environments: { find: async () => null },
      resources: {
        resolve: async () => ({
          type: "resolved" as const,
          resources: [],
          secrets: [],
        }),
      },
      lifecycle: {
        sessionStarted: async () => {},
        sessionStopped: async () => {},
      },
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextSessionId: () => "session_01" },
    });
    const environmentDependencies = environmentsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: environmentPersistence,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextEnvironmentId: () => "env_01" },
    });
    const environmentWorkDependencies = environmentWorkDependenciesFromV0({
      workspaceId: "workspace_01",
      environments: {} as never,
      persistence: environmentWorkPersistence,
      availability: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
    });
    const environmentWorkEnqueuerDependencies =
      environmentWorkEnqueuerDependenciesFromV0({
        workspaceId: "workspace_01",
        persistence: environmentWorkPersistence,
        credentials: {} as never,
        clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
        ids: { nextEnvironmentWorkId: () => "work_01" },
      });
    const fileDependencies = filesDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: filePersistence,
      content: {
        put: async () => {},
        get: async () => null,
        delete: async () => {},
      },
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextFileId: () => "file_01" },
    });
    const memoryStoreDependencies = memoryStoresDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: memoryStorePersistence,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextMemoryStoreId: () => "memstore_01" },
    });
    const memoryDependencies = memoriesDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: memoryPersistence,
      memoryStores: { find: async () => null },
      content: {
        describe: async () => ({ sha256: "a".repeat(64), sizeBytes: 0 }),
      },
      actor: { kind: "api", apiKeyId: "apikey_01" },
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: {
        nextMemoryId: () => "mem_01",
        nextMemoryVersionId: () => "memver_01",
      },
    });
    const memoryVersionDependencies = memoryVersionsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: memoryPersistence,
      actor: { kind: "api", apiKeyId: "apikey_01" },
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
    });
    const vaultDependencies = vaultsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: vaultPersistence,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextVaultId: () => "vlt_01" },
    });
    const skillDependencies = skillsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: skillPersistence,
      compiler: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: {
        nextSkillId: () => "skill_01",
        nextSkillVersionId: () => "skv_01",
        nextSkillVersion: () => "1756202400000000",
      },
    });
    const skillVersionDependencies = skillVersionsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: skillPersistence,
      compiler: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: {
        nextSkillVersionId: () => "skv_01",
        nextSkillVersion: () => "1756202400000000",
      },
    });
    const tunnelDependencies = tunnelsDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: tunnelPersistence,
      provisioner: {} as never,
      tokens: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextTunnelId: () => "tnl_01" },
    });
    const tunnelCertificateDependencies = tunnelCertificatesDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: tunnelPersistence,
      certificateAuthority: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextTunnelCertificateId: () => "tcrt_01" },
    });
    const userProfileDependencies = userProfilesDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence: userProfilePersistence,
      enrollment: {} as never,
      clock: { now: () => new Date("2026-08-26T00:00:00.000Z") },
      ids: { nextUserProfileId: () => "uprof_01" },
    });

    expect(agentDependencies.store).toBe(agentPersistence);
    expect(credentialDependencies.store).toBe(credentialPersistence);
    expect(deploymentDependencies.store).toBe(deploymentPersistence);
    expect(deploymentRunDependencies.store).toBe(deploymentRunPersistence);
    expect(dreamDependencies.store).toBe(dreamPersistence);
    expect(dreamExecutionDependencies.store).toBe(dreamPersistence);
    expect(environmentDependencies.store).toBe(environmentPersistence);
    expect(environmentWorkDependencies.store).toBe(environmentWorkPersistence);
    expect(environmentWorkEnqueuerDependencies.store).toBe(
      environmentWorkPersistence,
    );
    expect(fileDependencies.store).toBe(filePersistence);
    expect(memoryStoreDependencies.store).toBe(memoryStorePersistence);
    expect(memoryDependencies.store).toBe(memoryPersistence);
    expect(memoryVersionDependencies.store).toBe(memoryPersistence);
    expect(sessionDependencies.store).toBe(sessionPersistence);
    expect(skillDependencies.store).toBe(skillPersistence);
    expect(skillVersionDependencies.store).toBe(skillPersistence);
    expect(tunnelDependencies.store).toBe(tunnelPersistence);
    expect(tunnelCertificateDependencies.store).toBe(tunnelPersistence);
    expect(userProfileDependencies.store).toBe(userProfilePersistence);
    expect(vaultDependencies.store).toBe(vaultPersistence);
    expect("persistence" in agentDependencies).toBe(false);
    expect("persistence" in credentialDependencies).toBe(false);
    expect("persistence" in deploymentDependencies).toBe(false);
    expect("persistence" in deploymentRunDependencies).toBe(false);
    expect("persistence" in dreamDependencies).toBe(false);
    expect("persistence" in dreamExecutionDependencies).toBe(false);
    expect("persistence" in environmentDependencies).toBe(false);
    expect("persistence" in environmentWorkDependencies).toBe(false);
    expect("persistence" in environmentWorkEnqueuerDependencies).toBe(false);
    expect("persistence" in fileDependencies).toBe(false);
    expect("persistence" in memoryStoreDependencies).toBe(false);
    expect("persistence" in memoryDependencies).toBe(false);
    expect("persistence" in memoryVersionDependencies).toBe(false);
    expect("persistence" in sessionDependencies).toBe(false);
    expect("persistence" in skillDependencies).toBe(false);
    expect("persistence" in skillVersionDependencies).toBe(false);
    expect("persistence" in tunnelDependencies).toBe(false);
    expect("persistence" in tunnelCertificateDependencies).toBe(false);
    expect("persistence" in userProfileDependencies).toBe(false);
    expect("persistence" in vaultDependencies).toBe(false);
  });
});
