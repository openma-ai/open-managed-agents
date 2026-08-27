import { describe, expect, it } from "vitest";

import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import type { Agent } from "@open-managed-agents/domain/agents";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  deploymentSessionLauncherPort,
  sessionAgentSourcePort,
  sessionEnvironmentSourcePort,
  sessionLifecyclePort,
  sessionResourceResolverPort,
  sessionStorePort,
  sessionsModule,
} from "../src/modules/sessions";

const agent: Agent = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-sonnet-4-6" },
  multiagent: null,
  name: "Agent",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

describe("Sessions application module", () => {
  it("constructs Sessions only from declared domain Ports", async () => {
    const started: object[] = [];
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => `${namespace}_01`,
        }),
        providePort(sessionStorePort, new MemorySessionStore()),
        providePort(sessionAgentSourcePort, {
          findCurrent: async () => structuredClone(agent),
          findVersion: async () => null,
        }),
        providePort(sessionEnvironmentSourcePort, {
          find: async () => ({
            id: "environment_01",
            archivedAt: null,
            config: { type: "self_hosted" as const },
            createdAt: "2026-08-26T00:00:00.000Z",
            description: null,
            metadata: {},
            name: "Runtime",
            updatedAt: "2026-08-26T00:00:00.000Z",
          }),
        }),
        providePort(sessionResourceResolverPort, {
          resolve: async () => ({
            type: "resolved" as const,
            resources: [],
            secrets: [],
          }),
        }),
        providePort(sessionLifecyclePort, {
          sessionStarted: async (input) => { started.push(input); },
          sessionStopped: async () => {},
        }),
        sessionsModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.sessions).createSession({
      agent: { type: "latest", agentId: "agent_01" },
      environmentId: "environment_01",
    })).resolves.toMatchObject({
      type: "created",
      session: {
        id: "session_01",
        agent: { id: "agent_01", version: 1 },
      },
    });
    expect(started).toHaveLength(1);
    expect(app.port(deploymentSessionLauncherPort)).toBe(
      app.port(managedAgentsPortTokens.sessions),
    );
  });
});
