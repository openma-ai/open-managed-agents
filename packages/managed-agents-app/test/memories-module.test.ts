import { describe, expect, it } from "vitest";
import { InMemoryMemoryDocumentStore } from "@open-managed-agents/memory-document-store-memory";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  memoriesModule,
  memoryContentDescriptorPort,
  memoryDocumentStorePort,
  memoryStoreForMemorySourcePort,
  memoryVersionActorPort,
  memoryVersionsModule,
} from "../src/modules/memories";

describe("Memories application modules", () => {
  it("composes SDK projection and immutable history over shared Store Ports", async () => {
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) =>
            namespace === "memory" ? "mem_01" : "memver_01",
        }),
        providePort(
          memoryDocumentStorePort,
          new InMemoryMemoryDocumentStore(),
        ),
        providePort(memoryStoreForMemorySourcePort, {
          find: async () => ({
            id: "memstore_01",
            archivedAt: null,
            createdAt: "2026-08-26T10:00:00.000Z",
            name: "Project memory",
            updatedAt: "2026-08-26T10:00:00.000Z",
          }),
        }),
        providePort(memoryContentDescriptorPort, {
          describe: async () => ({
            sha256: "a".repeat(64),
            sizeBytes: 5,
          }),
        }),
        providePort(memoryVersionActorPort, {
          kind: "api",
          apiKeyId: "apikey_01",
        }),
        memoriesModule(),
        memoryVersionsModule(),
      ],
    });

    await expect(app.port(managedAgentsPortTokens.memories).createMemory({
      memoryStoreId: "memstore_01",
      content: "hello",
      path: "/notes/one.md",
      projection: "full",
    })).resolves.toMatchObject({
      type: "created",
      memory: {
        id: "mem_01",
        content: "hello",
        memoryVersionId: "memver_01",
      },
    });
    await expect(
      app.port(managedAgentsPortTokens.memoryVersions).retrieveMemoryVersion({
        memoryStoreId: "memstore_01",
        memoryVersionId: "memver_01",
        projection: "full",
      }),
    ).resolves.toMatchObject({
      type: "found",
      version: { id: "memver_01", content: "hello" },
    });
  });
});
