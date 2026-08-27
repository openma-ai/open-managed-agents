import { describe, expect, it } from "vitest";
import { MemoryEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-memory";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { createApp, providePort } from "../src/index";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  environmentSessionWorkEnqueuerPort,
  environmentWorkAvailabilityWaiterPort,
  environmentWorkEnqueuerModule,
  environmentWorkEnvironmentSourcePort,
  environmentWorkModule,
  environmentWorkSessionCredentialIssuerPort,
  environmentWorkStorePort,
} from "../src/modules/environment-work";

describe("Environment Work modules", () => {
  it("shares one Store between the SDK work surface and Session enqueuer", async () => {
    const store = new MemoryEnvironmentWorkStore();
    await store.insert({
      workspaceId: "workspace_01",
      record: {
        work: {
          id: "work_01",
          acknowledgedAt: null,
          createdAt: "2026-08-26T09:00:00.000Z",
          data: { type: "session", id: "session_01" },
          environmentId: "env_01",
          latestHeartbeatAt: null,
          metadata: {},
          startedAt: null,
          state: "queued",
          stopRequestedAt: null,
          stoppedAt: null,
        },
        secret: { sessionsToken: "secret" },
        claim: null,
        heartbeatTtlSeconds: 90,
      },
    });
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, { now: () => new Date("2026-08-26T09:00:00.000Z") }),
        providePort(idGeneratorPort, { next: () => "work_02" }),
        providePort(environmentWorkStorePort, store),
        providePort(environmentWorkEnvironmentSourcePort, { find: async () => null }),
        providePort(environmentWorkAvailabilityWaiterPort, { wait: async () => {} }),
        providePort(environmentWorkSessionCredentialIssuerPort, {
          issue: async () => ({
            type: "issued" as const,
            secret: { sessionsToken: "issued" },
          }),
        }),
        environmentWorkModule(),
        environmentWorkEnqueuerModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.environmentWork)
      .retrieveEnvironmentWork({ environmentId: "env_01", workId: "work_01" }))
      .resolves.toMatchObject({ type: "found", work: { id: "work_01", secret: null } });
    expect(app.port(environmentSessionWorkEnqueuerPort)).toBeDefined();
  });
});
