import { describe, expect, it } from "vitest";
import type { Agent } from "../src/domain/agent";
import type { Deployment } from "../src/domain/deployment";
import type { Environment } from "../src/domain/environment";
import { SessionsApplicationService } from "../src/sessions/application";

const agent: Agent = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T10:00:00.000Z",
  description: null,
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
  name: "Local",
  updatedAt: "2026-08-26T10:00:00.000Z",
};

const deployment: Deployment = {
  id: "depl_01",
  agent: { id: "agent_01", version: 3 },
  archivedAt: null,
  createdAt: "2026-08-26T14:00:00.000Z",
  description: null,
  environmentId: "env_01",
  initialEvents: [
    {
      type: "system.message",
      content: [{ type: "text", text: "Use read-only checks" }],
    },
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
      kind: "github_repository",
      url: "https://github.com/example/repo",
      mountPath: "/workspace/repo",
    },
  ],
  schedule: null,
  status: "active",
  updatedAt: "2026-08-26T14:00:00.000Z",
  vaultIds: ["vlt_01"],
};

describe("Sessions deployment launcher", () => {
  it("starts a deployment-linked Session with system events and restored secrets", async () => {
    const resourceCalls: object[] = [];
    const insertCalls: object[] = [];
    const lifecycleCalls: object[] = [];
    const unexpected = (operation: string) => async () => {
      throw new Error(`unexpected ${operation} call`);
    };
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      agents: {
        findCurrent: async () => agent,
        findVersion: async () => agent,
      },
      environments: { find: async () => environment },
      resources: {
        resolve: async (input) => {
          resourceCalls.push(input);
          return { type: "resolved", resources: [], secrets: [] };
        },
      },
      store: {
        insert: async (input) => {
          insertCalls.push(input);
          return { session: input.session, revision: 1 };
        },
        findCurrent: unexpected("findCurrent"),
        replaceCurrent: unexpected("replaceCurrent"),
        archiveCurrent: unexpected("archiveCurrent"),
        deleteCurrent: unexpected("deleteCurrent"),
        listCurrent: unexpected("listCurrent"),
      },
      lifecycle: {
        sessionStarted: async (input) => {
          lifecycleCalls.push(input);
        },
        sessionStopped: unexpected("sessionStopped"),
      },
      clock: { now: () => new Date("2026-08-26T15:00:00.000Z") },
      ids: {
        nextSessionId: () => "session_01",
      },
    });

    const result = await service.launch({
      workspaceId: "workspace_01",
      deployment,
      resourceSecrets: [
        {
          kind: "github_repository_token",
          resourceIndex: 0,
          authorizationToken: "github-secret",
        },
      ],
      run: {
        id: "drun_01",
        agent: deployment.agent,
        createdAt: "2026-08-26T15:00:00.000Z",
        deploymentId: "depl_01",
        error: null,
        sessionId: null,
        triggerContext: { kind: "manual" },
      },
    });

    expect(resourceCalls).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        createdAt: "2026-08-26T15:00:00.000Z",
        resources: [
          {
            type: "github_repository",
            authorizationToken: "github-secret",
            url: "https://github.com/example/repo",
            mountPath: "/workspace/repo",
          },
        ],
      },
    ]);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      workspaceId: "workspace_01",
      session: {
        id: "session_01",
        deploymentId: "depl_01",
        title: "repository-maintenance",
      },
      initialEvents: deployment.initialEvents,
    });
    expect(lifecycleCalls[0]).toMatchObject({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      initialEvents: deployment.initialEvents,
    });
    expect(result).toEqual({ type: "launched", sessionId: "session_01" });
  });
});
