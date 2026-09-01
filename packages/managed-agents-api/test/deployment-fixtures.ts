import type {
  DeploymentRunsApplicationPort,
  DeploymentRunView,
  DeploymentsApplicationPort,
  DeploymentView,
} from "../src/index";

export const deploymentRunView: DeploymentRunView = {
  id: "drun_01",
  agent: { id: "agent_01", version: 3 },
  createdAt: "2026-08-26T15:05:00.000Z",
  deploymentId: "depl_01",
  error: null,
  sessionId: "session_01",
  triggerContext: { kind: "manual" },
};

export const deploymentView: DeploymentView = {
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
    {
      type: "user.define_outcome",
      description: "Repository is healthy",
      rubric: { type: "text", content: "All checks pass" },
      maxIterations: 3,
    },
    {
      type: "system.message",
      content: [{ type: "text", text: "Use conservative changes" }],
    },
  ],
  metadata: { team: "platform" },
  name: "repository-maintenance",
  pausedReason: null,
  resources: [
    { kind: "file", fileId: "file_01", mountPath: "/workspace/input.txt" },
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
};

export function makeDeploymentsPort(
  overrides: Partial<DeploymentsApplicationPort>,
): DeploymentsApplicationPort {
  return {
    createDeployment: async () => {
      throw new Error("unexpected createDeployment application port call");
    },
    retrieveDeployment: async () => {
      throw new Error("unexpected retrieveDeployment application port call");
    },
    updateDeployment: async () => {
      throw new Error("unexpected updateDeployment application port call");
    },
    listDeployments: async () => {
      throw new Error("unexpected listDeployments application port call");
    },
    archiveDeployment: async () => {
      throw new Error("unexpected archiveDeployment application port call");
    },
    pauseDeployment: async () => {
      throw new Error("unexpected pauseDeployment application port call");
    },
    runDeployment: async () => {
      throw new Error("unexpected runDeployment application port call");
    },
    unpauseDeployment: async () => {
      throw new Error("unexpected unpauseDeployment application port call");
    },
    ...overrides,
  };
}

export function makeDeploymentRunsPort(
  overrides: Partial<DeploymentRunsApplicationPort>,
): DeploymentRunsApplicationPort {
  return {
    retrieveDeploymentRun: async () => {
      throw new Error("unexpected retrieveDeploymentRun application port call");
    },
    listDeploymentRuns: async () => {
      throw new Error("unexpected listDeploymentRuns application port call");
    },
    ...overrides,
  };
}
