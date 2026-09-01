import { describe, expect, it } from "vitest";
import type {
  Environment,
  Session,
} from "@open-managed-agents/managed-agents-application";
import { EnvironmentAwareSessionLifecycleRouter } from "../src";

const session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T09:20:00.000Z",
  environmentId: "env_self_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T09:20:00.000Z",
  usage: {},
  vaultIds: [],
} satisfies Session;

const selfHostedEnvironment = {
  id: "env_self_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T09:00:00.000Z",
  description: null,
  metadata: {},
  name: "Self hosted",
  updatedAt: "2026-08-26T09:00:00.000Z",
} satisfies Environment;

describe("Environment-aware Session lifecycle router", () => {
  it("queues self-hosted starts and routes their stops through Environment Work", async () => {
    const workCalls: object[] = [];
    const router = new EnvironmentAwareSessionLifecycleRouter({
      environments: { find: async () => selfHostedEnvironment },
      runtime: {
        sessionStarted: async () => {
          throw new Error("unexpected runtime start");
        },
        sessionStopped: async () => {
          throw new Error("unexpected runtime stop");
        },
      },
      selfHostedWork: {
        enqueue: async (input) => {
          workCalls.push({ operation: "enqueue", input });
          return {
            type: "queued",
            work: {
              id: "work_01",
              acknowledgedAt: null,
              createdAt: session.createdAt,
              data: { type: "session", id: session.id },
              environmentId: selfHostedEnvironment.id,
              latestHeartbeatAt: null,
              metadata: {},
              startedAt: null,
              state: "queued",
              stopRequestedAt: null,
              stoppedAt: null,
            },
          };
        },
        stop: async (input) => {
          workCalls.push({ operation: "stop", input });
          return { type: "not_found" };
        },
      },
    });

    await router.sessionStarted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment: selfHostedEnvironment,
      initialEvents: [],
    });
    await router.sessionStopped({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      reason: "deleted",
    });

    expect(workCalls).toEqual([
      {
        operation: "enqueue",
        input: {
          workspaceId: "workspace_01",
          environment: selfHostedEnvironment,
          session,
        },
      },
      {
        operation: "stop",
        input: {
          workspaceId: "workspace_01",
          session,
          reason: "deleted",
        },
      },
    ]);
  });
});
