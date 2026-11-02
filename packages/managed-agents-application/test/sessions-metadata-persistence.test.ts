import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import type { Agent } from "../src/domain/agent";
import type { Environment } from "../src/domain/environment";
import { SessionsApplicationService } from "../src/index";

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
  system: "system",
  tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Local runtime",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

describe("SessionsApplicationService session metadata persistence", () => {
  it("stores metadata on create and returns it on retrieve", async () => {
    const store = new MemorySessionStore();
    const service = new SessionsApplicationService({
      workspaceId: "workspace_01",
      store,
      agents: {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      },
      environments: {
        find: async (input) =>
          input.environmentId === environment.id
            ? structuredClone(environment)
            : null,
      },
      resources: {
        resolve: async () => ({
          type: "resolved",
          resources: [],
          secrets: [],
        }),
      },
      lifecycle: {
        sessionStarted: async () => {},
        sessionStopped: async () => {},
      },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextSessionId: () => "session_meta" },
    });

    const created = await service.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: environment.id,
      metadata: { project_id: "proj_a", creation_key: "ck_1" },
    });
    expect(created.type).toBe("created");
    if (created.type !== "created") return;
    expect(created.session.metadata).toEqual({
      project_id: "proj_a",
      creation_key: "ck_1",
    });

    const retrieved = await service.retrieveSession({ sessionId: "session_meta" });
    expect(retrieved.type).toBe("found");
    if (retrieved.type !== "found") return;
    expect(retrieved.session.metadata).toEqual({
      project_id: "proj_a",
      creation_key: "ck_1",
    });
  });
});
