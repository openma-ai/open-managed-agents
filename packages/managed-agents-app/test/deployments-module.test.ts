import { describe, expect, it } from "vitest";
import { MemoryDeploymentStore } from "@open-managed-agents/deployment-store-memory";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  deploymentAgentSourcePort,
  deploymentEnvironmentSourcePort,
  deploymentFileSourcePort,
  deploymentMemoryStoreSourcePort,
  deploymentRunPersistencePort,
  deploymentSchedulePlannerPort,
  deploymentSessionLauncherPort,
  deploymentStorePort,
  deploymentVaultSourcePort,
  deploymentsModule,
} from "../src/modules/deployments";

describe("Deployments application module", () => {
  it("composes the retained service over narrow Store and dependency Ports", async () => {
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => namespace === "deployment"
            ? "depl_01"
            : "drun_01",
        }),
        providePort(deploymentStorePort, new MemoryDeploymentStore()),
        providePort(deploymentAgentSourcePort, {
          find: async () => ({
            id: "agent_01",
            archivedAt: null,
            createdAt: "2026-08-26T10:00:00.000Z",
            description: null,
            mcpServers: [],
            metadata: {},
            model: { id: "claude-opus-5" },
            multiagent: null,
            name: "Agent",
            skills: [],
            system: null,
            tools: [],
            updatedAt: "2026-08-26T10:00:00.000Z",
            version: 1,
          }),
        }),
        providePort(deploymentEnvironmentSourcePort, {
          find: async () => ({
            id: "env_01",
            archivedAt: null,
            config: { type: "self_hosted" as const },
            createdAt: "2026-08-26T10:00:00.000Z",
            description: null,
            metadata: {},
            name: "Production",
            updatedAt: "2026-08-26T10:00:00.000Z",
          }),
        }),
        providePort(deploymentFileSourcePort, { find: async () => null }),
        providePort(deploymentMemoryStoreSourcePort, { find: async () => null }),
        providePort(deploymentRunPersistencePort, {
          beginManual: async () => ({ type: "not_found" as const }),
          finalize: async () => ({ type: "not_found" as const }),
          find: async () => null,
          list: async () => [],
        }),
        providePort(deploymentSchedulePlannerPort, {
          plan: async () => ({
            type: "invalid_schedule" as const,
            message: "unexpected",
          }),
        }),
        providePort(deploymentSessionLauncherPort, {
          launch: async () => ({ type: "launched" as const, sessionId: "session_01" }),
        }),
        providePort(deploymentVaultSourcePort, { find: async () => null }),
        deploymentsModule(),
      ],
    });
    const deployments = app.port(managedAgentsPortTokens.deployments);

    await expect(deployments.createDeployment({
      agent: { kind: "latest", agentId: "agent_01" },
      environmentId: "env_01",
      initialEvents: [{
        type: "user.message",
        content: [{ type: "text", text: "Inspect" }],
      }],
      name: "Maintenance",
    })).resolves.toMatchObject({
      type: "created",
      deployment: { id: "depl_01", name: "Maintenance" },
    });
    await expect(deployments.retrieveDeployment({ deploymentId: "depl_01" }))
      .resolves.toMatchObject({
        type: "found",
        deployment: { id: "depl_01", environmentId: "env_01" },
      });
  });
});
