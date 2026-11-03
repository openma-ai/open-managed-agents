import { describe, expect, it } from "vitest";
import type { AgentStore } from "@openma/core/storage";

import { MemoryAgentStore, MemorySessionStore, memoryStores } from "../src/index";

describe("memoryStores", () => {
  it("returns one store per storage Port", () => {
    const stores = memoryStores();
    expect(Object.keys(stores).sort()).toEqual([
      "agents",
      "credentials",
      "deploymentRuns",
      "deployments",
      "dreams",
      "environmentWork",
      "environments",
      "files",
      "memories",
      "memoryStores",
      "sessionEvents",
      "sessionResources",
      "sessionThreads",
      "sessions",
      "skills",
      "tunnels",
      "userProfiles",
      "vaults",
    ]);
    expect(stores.agents).toBeInstanceOf(MemoryAgentStore);
  });

  it("keeps overrides and wires dependent stores to the overriding Session store", async () => {
    const agents: AgentStore = new MemoryAgentStore();
    const sessions = new MemorySessionStore();
    const stores = memoryStores({ agents, sessions });
    expect(stores.agents).toBe(agents);
    expect(stores.sessions).toBe(sessions);
    await expect(stores.sessionResources.findCurrent({
      workspaceId: "workspace_1",
      sessionId: "session_missing",
    })).resolves.toBeNull();
  });
});
