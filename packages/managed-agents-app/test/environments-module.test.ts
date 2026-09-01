import { describe, expect, it } from "vitest";
import { MemoryEnvironmentStore } from "@open-managed-agents/environment-store-memory";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { createApp, providePort } from "../src/index";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  environmentStorePort,
  environmentsModule,
} from "../src/modules/environments";

describe("environmentsModule", () => {
  it("binds a workspace-scoped application Port to the narrow Store", async () => {
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        }),
        providePort(idGeneratorPort, { next: () => "env_01" }),
        providePort(environmentStorePort, new MemoryEnvironmentStore()),
        environmentsModule(),
      ],
    });

    await expect(
      app.port(managedAgentsPortTokens.environments).createEnvironment({
        name: "Local",
        config: { type: "self_hosted" },
      }),
    ).resolves.toMatchObject({
      type: "created",
      environment: { id: "env_01", name: "Local" },
    });
  });
});
