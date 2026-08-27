import { describe, expect, it } from "vitest";
import { createApp, providePort } from "../src/index";
import { workspaceContextPort } from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  deploymentRunStorePort,
  deploymentRunsModule,
} from "../src/modules/deployment-runs";

const run = {
  id: "drun_01",
  agent: { id: "agent_01", version: 3 },
  createdAt: "2026-08-26T15:00:00.000Z",
  deploymentId: "depl_01",
  error: null,
  sessionId: "session_01",
  triggerContext: { kind: "manual" as const },
};

describe("Deployment Runs application module", () => {
  it("composes the retained query service over the narrow Store Port", async () => {
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(deploymentRunStorePort, {
          beginManual: async () => ({ type: "not_found" as const }),
          finalize: async () => ({ type: "not_found" as const }),
          find: async () => ({ run, revision: 2 }),
          list: async () => [{ run, revision: 2 }],
        }),
        deploymentRunsModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.deploymentRuns)
      .retrieveDeploymentRun({ deploymentRunId: "drun_01" }))
      .resolves.toEqual({ type: "found", run });
  });
});
