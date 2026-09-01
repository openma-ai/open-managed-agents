import { describe, expect, it } from "vitest";
import { InMemoryMemoryStoreStore } from "@open-managed-agents/memory-store-store-memory";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  memoryStoreStorePort,
  memoryStoresModule,
} from "../src/modules/memory-stores";

describe("Memory Stores application module", () => {
  it("composes retained SDK semantics over a replaceable Store Port", async () => {
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => `${namespace}_01`,
        }),
        providePort(memoryStoreStorePort, new InMemoryMemoryStoreStore()),
        memoryStoresModule(),
      ],
    });
    const memoryStores = app.port(managedAgentsPortTokens.memoryStores);

    await expect(memoryStores.createMemoryStore({
      name: "Project memory",
      description: "Durable decisions",
      metadata: { owner: "workspace_01" },
    })).resolves.toMatchObject({
      type: "created",
      memoryStore: {
        id: "memory_store_01",
        name: "Project memory",
        archivedAt: null,
      },
    });
    await expect(memoryStores.listMemoryStores({ pageSize: 20 })).resolves
      .toMatchObject({
        type: "page",
        page: { memoryStores: [{ id: "memory_store_01" }] },
      });
  });
});
