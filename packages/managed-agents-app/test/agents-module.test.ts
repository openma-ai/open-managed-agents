import { describe, expect, it } from "vitest";

import type { AgentStore } from "@open-managed-agents/agent-store";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import { agentStorePort, agentsModule } from "../src/modules/agents";

describe("Agents application module", () => {
  it("constructs the inbound Agents Port only from declared outbound Ports", async () => {
    const persistence = {
      insert: async (input) => structuredClone(input.agent),
      findCurrent: async () => null,
      findVersion: async () => null,
      replaceCurrent: async () => ({ type: "not_found" as const }),
      archiveCurrent: async () => ({ type: "not_found" as const }),
      listCurrent: async () => [],
      listVersions: async () => [],
    } satisfies AgentStore;
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace-1" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => `${namespace}_01`,
        }),
        providePort(agentStorePort, persistence),
        agentsModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.agents).createAgent({
      name: "Coding Assistant",
      model: "claude-opus-5",
    })).resolves.toMatchObject({
      type: "created",
      agent: {
        id: "agent_01",
        name: "Coding Assistant",
        createdAt: "2026-08-26T12:00:00.000Z",
      },
    });
  });
});
