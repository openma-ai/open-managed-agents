import { describe, expect, it } from "vitest";
import type { Agent } from "../src/domain/agent";
import type { Deployment } from "../src/domain/deployment";
import type { Environment } from "../src/domain/environment";
import type { FileMetadata } from "../src/domain/file";
import type { MemoryStore } from "../src/domain/memory-store";
import type { Vault } from "../src/domain/vault";
import { DeploymentsApplicationService } from "../src/deployments/application";
import type { DeploymentAgentSourcePort } from "../src/deployments/agent-source";
import type { DeploymentEnvironmentSourcePort } from "../src/deployments/environment-source";
import type { DeploymentFileSourcePort } from "../src/deployments/file-source";
import type { DeploymentMemoryStoreSourcePort } from "../src/deployments/memory-store-source";
import type { DeploymentSchedulePlannerPort } from "../src/deployments/schedule-planner";
import type { DeploymentSessionLauncherPort } from "../src/deployments/session-launcher";
import type { DeploymentVaultSourcePort } from "../src/deployments/vault-source";
import type { DeploymentRunPersistencePort } from "../src/deployment-runs/persistence";
import type { DeploymentStore } from "@open-managed-agents/deployment-store";

const agent: Agent = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  description: "Repository agent",
  mcpServers: [],
  metadata: {},
  model: { id: "claude-opus-5" },
  multiagent: null,
  name: "Repository agent",
  skills: [],
  system: "Work carefully",
  tools: [],
  updatedAt: "2026-08-26T10:00:00.000Z",
  version: 3,
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T10:00:00.000Z",
  description: null,
  metadata: {},
  name: "Production",
  updatedAt: "2026-08-26T10:00:00.000Z",
};

const file: FileMetadata = {
  id: "file_01",
  createdAt: "2026-08-26T10:00:00.000Z",
  filename: "input.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};

const memoryStore: MemoryStore = {
  id: "memstore_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  name: "Facts",
  updatedAt: "2026-08-26T10:00:00.000Z",
};

const vault: Vault = {
  id: "vlt_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  displayName: "Production secrets",
  metadata: {},
  updatedAt: "2026-08-26T10:00:00.000Z",
};

const deployment = {
  id: "depl_01",
  agent: { id: "agent_01", version: 3 },
  archivedAt: null,
  createdAt: "2026-08-26T15:00:00.000Z",
  description: "Daily repository maintenance",
  environmentId: "env_01",
  initialEvents: [
    {
      type: "user.message" as const,
      content: [{ type: "text" as const, text: "Inspect the repository" }],
    },
  ],
  metadata: { team: "platform" },
  name: "repository-maintenance",
  pausedReason: null,
  resources: [
    {
      kind: "github_repository" as const,
      url: "https://github.com/example/repo",
      mountPath: "/workspace/repo",
    },
  ],
  schedule: null,
  status: "active" as const,
  updatedAt: "2026-08-26T15:00:00.000Z",
  vaultIds: ["vlt_01"],
};

const resourceSecrets = [
  {
    kind: "github_repository_token" as const,
    resourceIndex: 0,
    authorizationToken: "github-secret",
  },
];

function makeDependencies(overrides: {
  agents?: Partial<DeploymentAgentSourcePort>;
  environments?: Partial<DeploymentEnvironmentSourcePort>;
  files?: Partial<DeploymentFileSourcePort>;
  memoryStores?: Partial<DeploymentMemoryStoreSourcePort>;
  store?: Partial<DeploymentStore>;
  runs?: Partial<DeploymentRunPersistencePort>;
  schedules?: Partial<DeploymentSchedulePlannerPort>;
  sessions?: Partial<DeploymentSessionLauncherPort>;
  vaults?: Partial<DeploymentVaultSourcePort>;
} = {}) {
  const unexpected = (operation: string) => async () => {
    throw new Error(`unexpected ${operation} call`);
  };
  return {
    workspaceId: "workspace_01",
    agents: {
      find: unexpected("find agent"),
      ...overrides.agents,
    } satisfies DeploymentAgentSourcePort,
    environments: {
      find: unexpected("find environment"),
      ...overrides.environments,
    } satisfies DeploymentEnvironmentSourcePort,
    files: {
      find: unexpected("find file"),
      ...overrides.files,
    } satisfies DeploymentFileSourcePort,
    memoryStores: {
      find: unexpected("find memory store"),
      ...overrides.memoryStores,
    } satisfies DeploymentMemoryStoreSourcePort,
    store: {
      insert: unexpected("insert"),
      find: unexpected("find"),
      replace: unexpected("replace"),
      list: unexpected("list"),
      ...overrides.store,
    } satisfies DeploymentStore,
    runs: {
      beginManual: unexpected("begin manual deployment run"),
      finalize: unexpected("finalize deployment run"),
      find: unexpected("find deployment run"),
      list: unexpected("list deployment runs"),
      ...overrides.runs,
    } satisfies DeploymentRunPersistencePort,
    schedules: {
      plan: unexpected("plan"),
      ...overrides.schedules,
    } satisfies DeploymentSchedulePlannerPort,
    sessions: {
      launch: unexpected("launch deployment session"),
      ...overrides.sessions,
    } satisfies DeploymentSessionLauncherPort,
    vaults: {
      find: unexpected("find vault"),
      ...overrides.vaults,
    } satisfies DeploymentVaultSourcePort,
    clock: { now: () => new Date("2026-08-26T15:00:00.000Z") },
    ids: {
      nextDeploymentId: () => "depl_01",
      nextDeploymentRunId: () => "drun_01",
    },
  };
}

describe("Deployments application", () => {
  it.each([
    [
      { name: "" },
      "Deployment name must contain 1 to 255 characters",
    ],
    [
      {
        name: "valid",
        resources: [
          {
            kind: "file" as const,
            fileId: "file_01",
            mountPath: "../escape",
          },
        ],
      },
      "Deployment resource mount path must be absolute and may not traverse parents",
    ],
    [
      {
        name: "valid",
        vaultIds: ["vlt_01", "vlt_01"],
      },
      "Vault vlt_01 is attached more than once",
    ],
  ])("rejects semantic invariants before reading dependencies", async (patch, message) => {
    const service = new DeploymentsApplicationService(makeDependencies());
    const { name, ...rest } = patch;

    await expect(
      service.createDeployment({
        agent: { kind: "latest", agentId: "agent_01" },
        environmentId: "env_01",
        initialEvents: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Inspect the repository" }],
          },
        ],
        name,
        ...rest,
      }),
    ).resolves.toEqual({ type: "invalid_request", message });
  });

  it("resolves complete dependencies and inserts one redacted deployment aggregate", async () => {
    const dependencyCalls: object[] = [];
    const scheduleCalls: object[] = [];
    const persistenceCalls: object[] = [];
    const service = new DeploymentsApplicationService(
      makeDependencies({
        agents: {
          find: async (input) => {
            dependencyCalls.push(input);
            return agent;
          },
        },
        environments: {
          find: async (input) => {
            dependencyCalls.push(input);
            return environment;
          },
        },
        files: {
          find: async (input) => {
            dependencyCalls.push(input);
            return file;
          },
        },
        memoryStores: {
          find: async (input) => {
            dependencyCalls.push(input);
            return memoryStore;
          },
        },
        vaults: {
          find: async (input) => {
            dependencyCalls.push(input);
            return vault;
          },
        },
        schedules: {
          plan: async (input) => {
            scheduleCalls.push(input);
            return {
              type: "planned",
              schedule: {
                expression: input.expression,
                timezone: input.timezone,
                lastRunAt: null,
                upcomingRunsAt: ["2026-08-27T09:00:00.000Z"],
              },
            };
          },
        },
        store: {
          insert: async (input) => {
            persistenceCalls.push(input);
            return { ...input.record, revision: 1 };
          },
        },
      }),
    );

    const result = await service.createDeployment({
      agent: { kind: "latest", agentId: "agent_01" },
      environmentId: "env_01",
      initialEvents: [
        {
          type: "user.message",
          content: [{ type: "text", text: "Inspect the repository" }],
        },
      ],
      name: "repository-maintenance",
      budget: { amountMinor: "500", currency: "USD" },
      description: "Daily repository maintenance",
      metadata: { team: "platform" },
      resources: [
        {
          kind: "file",
          fileId: "file_01",
          mountPath: "/workspace/input.txt",
        },
        {
          kind: "github_repository",
          authorizationToken: "github-secret",
          url: "https://github.com/example/repo",
          checkout: { type: "branch", name: "main" },
          mountPath: "/workspace/repo",
        },
        {
          kind: "memory_store",
          memoryStoreId: "memstore_01",
          access: "read_write",
          instructions: "Record durable facts",
        },
      ],
      schedule: {
        expression: "0 9 * * 1-5",
        timezone: "UTC",
      },
      vaultIds: ["vlt_01"],
    });

    expect(dependencyCalls).toEqual([
      {
        workspaceId: "workspace_01",
        selector: { kind: "latest", agentId: "agent_01" },
      },
      { workspaceId: "workspace_01", environmentId: "env_01" },
      { workspaceId: "workspace_01", fileId: "file_01" },
      { workspaceId: "workspace_01", memoryStoreId: "memstore_01" },
      { workspaceId: "workspace_01", vaultId: "vlt_01" },
    ]);
    expect(scheduleCalls).toEqual([
      {
        expression: "0 9 * * 1-5",
        timezone: "UTC",
        after: "2026-08-26T15:00:00.000Z",
      },
    ]);
    expect(persistenceCalls).toEqual([
      {
        workspaceId: "workspace_01",
        record: {
          deployment: {
            id: "depl_01",
            agent: { id: "agent_01", version: 3 },
            archivedAt: null,
            createdAt: "2026-08-26T15:00:00.000Z",
            description: "Daily repository maintenance",
            environmentId: "env_01",
            initialEvents: [
              {
                type: "user.message",
                content: [{ type: "text", text: "Inspect the repository" }],
              },
            ],
            metadata: { team: "platform" },
            name: "repository-maintenance",
            pausedReason: null,
            resources: [
              {
                kind: "file",
                fileId: "file_01",
                mountPath: "/workspace/input.txt",
              },
              {
                kind: "github_repository",
                url: "https://github.com/example/repo",
                checkout: { type: "branch", name: "main" },
                mountPath: "/workspace/repo",
              },
              {
                kind: "memory_store",
                memoryStoreId: "memstore_01",
                access: "read_write",
                instructions: "Record durable facts",
              },
            ],
            schedule: {
              expression: "0 9 * * 1-5",
              timezone: "UTC",
              lastRunAt: null,
              upcomingRunsAt: ["2026-08-27T09:00:00.000Z"],
            },
            status: "active",
            updatedAt: "2026-08-26T15:00:00.000Z",
            vaultIds: ["vlt_01"],
            budget: { amountMinor: "500", currency: "USD" },
          },
          resourceSecrets: [
            {
              kind: "github_repository_token",
              resourceIndex: 1,
              authorizationToken: "github-secret",
            },
          ],
        },
      },
    ]);
    expect(result).toEqual({
      type: "created",
      deployment: persistenceCalls[0] &&
        (persistenceCalls[0] as { record: { deployment: object } }).record
          .deployment,
    });
  });

  it("retrieves and paginates complete deployment aggregates without exposing secrets", async () => {
    const older = {
      ...deployment,
      id: "depl_00",
      createdAt: "2026-08-25T15:00:00.000Z",
      updatedAt: "2026-08-25T15:00:00.000Z",
    };
    const listCalls: object[] = [];
    const service = new DeploymentsApplicationService(
      makeDependencies({
        store: {
          find: async () => ({ deployment, resourceSecrets, revision: 2 }),
          list: async (input) => {
            listCalls.push(input);
            return input.position === undefined
              ? [
                  { deployment, resourceSecrets, revision: 2 },
                  { deployment: older, resourceSecrets: [], revision: 1 },
                ]
              : [{ deployment: older, resourceSecrets: [], revision: 1 }];
          },
        },
      }),
    );

    await expect(
      service.retrieveDeployment({ deploymentId: "depl_01" }),
    ).resolves.toEqual({ type: "found", deployment });
    const first = await service.listDeployments({
      pageSize: 1,
      agentId: "agent_01",
      createdAtOrAfter: "2026-08-01T00:00:00.000Z",
      createdAtOrBefore: "2026-08-31T23:59:59.000Z",
      includeArchived: true,
      status: "active",
    });
    expect(first.type).toBe("page");
    if (first.type !== "page") throw new Error("expected first page");
    expect(first.page.deployments).toEqual([deployment]);
    expect(JSON.stringify(first)).not.toContain("github-secret");
    expect(first.page.nextCursor).toEqual(expect.any(String));

    await expect(
      service.listDeployments({ pageSize: 1, cursor: first.page.nextCursor! }),
    ).resolves.toEqual({
      type: "page",
      page: { deployments: [older], nextCursor: null },
    });
    expect(listCalls).toEqual([
      {
        workspaceId: "workspace_01",
        limit: 2,
        includeArchived: true,
        agentId: "agent_01",
        createdAtOrAfter: "2026-08-01T00:00:00.000Z",
        createdAtOrBefore: "2026-08-31T23:59:59.000Z",
        status: "active",
      },
      {
        workspaceId: "workspace_01",
        limit: 2,
        includeArchived: false,
        position: {
          createdAt: "2026-08-26T15:00:00.000Z",
          deploymentId: "depl_01",
        },
      },
    ]);
    await expect(
      service.listDeployments({ cursor: "not-a-deployment-cursor" }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Invalid deployments page cursor",
    });
  });

  it("updates a complete aggregate and replaces resource secrets with optimistic concurrency", async () => {
    const replaceCalls: object[] = [];
    const replacementAgent = { ...agent, id: "agent_02", version: 5 };
    const replacementEnvironment = { ...environment, id: "env_02" };
    const service = new DeploymentsApplicationService(
      makeDependencies({
        agents: { find: async () => replacementAgent },
        environments: { find: async () => replacementEnvironment },
        files: { find: async () => file },
        store: {
          find: async () => ({ deployment, resourceSecrets, revision: 2 }),
          replace: async (input) => {
            replaceCalls.push(input);
            return {
              type: "replaced",
              record: { ...input.next, revision: input.expectedRevision + 1 },
            };
          },
        },
        schedules: {
          plan: async (input) => ({
            type: "planned",
            schedule: {
              expression: input.expression,
              timezone: input.timezone,
              lastRunAt: null,
              upcomingRunsAt: ["2026-08-27T10:00:00.000Z"],
            },
          }),
        },
      }),
    );

    const result = await service.updateDeployment({
      deploymentId: "depl_01",
      agent: { kind: "versioned", agentId: "agent_02", version: 5 },
      budget: null,
      description: null,
      environmentId: "env_02",
      initialEvents: [
        {
          type: "system.message",
          content: [{ type: "text", text: "Use read-only checks" }],
        },
      ],
      metadata: { team: null, owner: "operations" },
      name: "updated-maintenance",
      resources: [
        {
          kind: "file",
          fileId: "file_01",
          mountPath: "/workspace/input.txt",
        },
      ],
      schedule: { expression: "0 10 * * *", timezone: "UTC" },
      vaultIds: null,
    });

    expect(replaceCalls).toEqual([
      {
        workspaceId: "workspace_01",
        deploymentId: "depl_01",
        expectedRevision: 2,
        next: {
          deployment: {
            ...deployment,
            agent: { id: "agent_02", version: 5 },
            budget: null,
            description: null,
            environmentId: "env_02",
            initialEvents: [
              {
                type: "system.message",
                content: [{ type: "text", text: "Use read-only checks" }],
              },
            ],
            metadata: { owner: "operations" },
            name: "updated-maintenance",
            resources: [
              {
                kind: "file",
                fileId: "file_01",
                mountPath: "/workspace/input.txt",
              },
            ],
            schedule: {
              expression: "0 10 * * *",
              timezone: "UTC",
              lastRunAt: null,
              upcomingRunsAt: ["2026-08-27T10:00:00.000Z"],
            },
            updatedAt: "2026-08-26T15:00:00.000Z",
            vaultIds: [],
          },
          resourceSecrets: [],
        },
      },
    ]);
    expect(result).toEqual({
      type: "updated",
      deployment: (replaceCalls[0] as {
        next: { deployment: object };
      }).next.deployment,
    });
  });

  it.each([
    [
      { name: "" },
      "Deployment name must contain 1 to 255 characters",
    ],
    [
      {
        resources: [
          {
            kind: "file" as const,
            fileId: "file_01",
            mountPath: "/workspace/shared",
          },
          {
            kind: "file" as const,
            fileId: "file_02",
            mountPath: "/workspace/shared",
          },
        ],
      },
      "Deployment resource mount path /workspace/shared is already in use",
    ],
  ])(
    "rejects an invalid merged update before reading dependency sources",
    async (patch, message) => {
      const service = new DeploymentsApplicationService(
        makeDependencies({
          store: {
            find: async () => ({ deployment, resourceSecrets, revision: 2 }),
          },
        }),
      );

      await expect(
        service.updateDeployment({ deploymentId: "depl_01", ...patch }),
      ).resolves.toEqual({ type: "invalid_request", message });
    },
  );

  it("makes deployment update races explicit", async () => {
    const service = new DeploymentsApplicationService(
      makeDependencies({
        store: {
          find: async () => ({ deployment, resourceSecrets, revision: 2 }),
          replace: async () => ({
            type: "revision_conflict",
            actualRevision: 3,
          }),
        },
      }),
    );

    await expect(
      service.updateDeployment({ deploymentId: "depl_01", name: "next" }),
    ).resolves.toEqual({
      type: "version_conflict",
      message: "Deployment changed concurrently at revision 3",
    });
  });

  it("keeps an archived deployment read-only", async () => {
    const archived = {
      ...deployment,
      archivedAt: "2026-08-26T16:00:00.000Z",
      pausedReason: { kind: "manual" as const },
      status: "paused" as const,
    };
    const service = new DeploymentsApplicationService(
      makeDependencies({
        store: {
          find: async () => ({
            deployment: archived,
            resourceSecrets,
            revision: 5,
          }),
        },
      }),
    );

    await expect(
      service.updateDeployment({ deploymentId: "depl_01", name: "forbidden" }),
    ).resolves.toEqual({
      type: "version_conflict",
      message: "Deployment depl_01 is archived and read-only",
    });
  });

  it("uses CAS for pause, readiness-checked unpause, and archive transitions", async () => {
    const transitions: object[] = [];
    const makeTransitionService = (currentDeployment: Deployment) =>
      new DeploymentsApplicationService(
        makeDependencies({
          agents: { find: async () => agent },
          environments: { find: async () => environment },
          vaults: { find: async () => vault },
          store: {
            find: async () => ({
              deployment: currentDeployment,
              resourceSecrets,
              revision: 4,
            }),
            replace: async (input) => {
              transitions.push(input);
              return {
                type: "replaced",
                record: { ...input.next, revision: 5 },
              };
            },
          },
        }),
      );

    const paused = await makeTransitionService(deployment).pauseDeployment({
      deploymentId: "depl_01",
    });
    const manuallyPaused = {
      ...deployment,
      status: "paused" as const,
      pausedReason: { kind: "manual" as const },
    };
    const unpaused = await makeTransitionService(manuallyPaused).unpauseDeployment({
      deploymentId: "depl_01",
    });
    const archived = await makeTransitionService(deployment).archiveDeployment({
      deploymentId: "depl_01",
    });

    expect(paused).toMatchObject({
      type: "changed",
      deployment: {
        status: "paused",
        pausedReason: { kind: "manual" },
        updatedAt: "2026-08-26T15:00:00.000Z",
      },
    });
    expect(unpaused).toMatchObject({
      type: "changed",
      deployment: { status: "active", pausedReason: null },
    });
    expect(archived).toMatchObject({
      type: "changed",
      deployment: {
        archivedAt: "2026-08-26T15:00:00.000Z",
        status: "paused",
        pausedReason: { kind: "manual" },
      },
    });
    expect(transitions).toHaveLength(3);
    for (const transition of transitions) {
      expect(transition).toMatchObject({
        workspaceId: "workspace_01",
        deploymentId: "depl_01",
        expectedRevision: 4,
      });
    }
  });

  it("returns semantic conflicts for invalid state and concurrent transitions", async () => {
    const paused = {
      ...deployment,
      status: "paused" as const,
      pausedReason: { kind: "manual" as const },
    };
    const alreadyPaused = new DeploymentsApplicationService(
      makeDependencies({
        store: {
          find: async () => ({
            deployment: paused,
            resourceSecrets,
            revision: 4,
          }),
        },
      }),
    );
    await expect(
      alreadyPaused.pauseDeployment({ deploymentId: "depl_01" }),
    ).resolves.toEqual({
      type: "conflict",
      message: "Deployment depl_01 is already paused",
    });

    const racing = new DeploymentsApplicationService(
      makeDependencies({
        store: {
          find: async () => ({ deployment, resourceSecrets, revision: 4 }),
          replace: async () => ({
            type: "revision_conflict",
            actualRevision: 5,
          }),
        },
      }),
    );
    await expect(
      racing.pauseDeployment({ deploymentId: "depl_01" }),
    ).resolves.toEqual({
      type: "conflict",
      message: "Deployment changed concurrently at revision 5",
    });
  });

  it("begins, launches, and finalizes a manual run in recoverable phases", async () => {
    const calls: object[] = [];
    const service = new DeploymentsApplicationService(
      makeDependencies({
        agents: { find: async () => agent },
        environments: { find: async () => environment },
        vaults: { find: async () => vault },
        store: {
          find: async () => ({ deployment, resourceSecrets, revision: 4 }),
        },
        runs: {
          beginManual: async (input) => {
            calls.push({ operation: "begin", input });
            return { type: "began", record: { run: input.run, revision: 1 } };
          },
          finalize: async (input) => {
            calls.push({ operation: "finalize", input });
            return {
              type: "finalized",
              record: { run: input.next, revision: input.expectedRevision + 1 },
            };
          },
        },
        sessions: {
          launch: async (input) => {
            calls.push({ operation: "launch", input });
            return { type: "launched", sessionId: "session_01" };
          },
        },
      }),
    );

    const result = await service.runDeployment({ deploymentId: "depl_01" });

    const pendingRun = {
      id: "drun_01",
      agent: { id: "agent_01", version: 3 },
      createdAt: "2026-08-26T15:00:00.000Z",
      deploymentId: "depl_01",
      error: null,
      sessionId: null,
      triggerContext: { kind: "manual" as const },
    };
    expect(calls).toEqual([
      {
        operation: "begin",
        input: {
          workspaceId: "workspace_01",
          deploymentId: "depl_01",
          expectedDeploymentRevision: 4,
          run: pendingRun,
        },
      },
      {
        operation: "launch",
        input: {
          workspaceId: "workspace_01",
          deployment,
          resourceSecrets,
          run: pendingRun,
        },
      },
      {
        operation: "finalize",
        input: {
          workspaceId: "workspace_01",
          deploymentRunId: "drun_01",
          expectedRevision: 1,
          next: { ...pendingRun, sessionId: "session_01" },
        },
      },
    ]);
    expect(result).toEqual({
      type: "started",
      run: { ...pendingRun, sessionId: "session_01" },
    });
  });

  it("records a failed manual run when a resolved dependency is no longer ready", async () => {
    const finalized: object[] = [];
    const service = new DeploymentsApplicationService(
      makeDependencies({
        agents: { find: async () => agent },
        environments: {
          find: async () => ({
            ...environment,
            archivedAt: "2026-08-26T14:00:00.000Z",
          }),
        },
        store: {
          find: async () => ({ deployment, resourceSecrets, revision: 4 }),
        },
        runs: {
          beginManual: async (input) => ({
            type: "began",
            record: { run: input.run, revision: 1 },
          }),
          finalize: async (input) => {
            finalized.push(input);
            return {
              type: "finalized",
              record: { run: input.next, revision: 2 },
            };
          },
        },
      }),
    );

    const result = await service.runDeployment({ deploymentId: "depl_01" });

    expect(result).toEqual({
      type: "started",
      run: {
        id: "drun_01",
        agent: { id: "agent_01", version: 3 },
        createdAt: "2026-08-26T15:00:00.000Z",
        deploymentId: "depl_01",
        error: {
          type: "environment_archived_error",
          message:
            "Deployment depl_01 could not create a session: environment_archived_error",
        },
        sessionId: null,
        triggerContext: { kind: "manual" },
      },
    });
    expect(finalized).toHaveLength(1);
  });
});
