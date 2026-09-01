import { describe, expect, it } from "vitest";
import { SessionResourceResolverService } from "../src/index";

describe("SessionResourceResolverService", () => {
  it("resolves every create variant into public snapshots plus isolated secrets", async () => {
    let nextId = 0;
    const resolver = new SessionResourceResolverService({
      files: {
        find: async ({ workspaceId, fileId }) =>
          workspaceId === "workspace_01" && fileId === "file_01"
            ? {
                id: "file_01",
                createdAt: "2026-08-26T11:00:00.000Z",
                filename: "input.txt",
                mimeType: "text/plain",
                sizeBytes: 5,
                downloadable: true,
              }
            : null,
      },
      memoryStores: {
        find: async ({ workspaceId, memoryStoreId }) =>
          workspaceId === "workspace_01" && memoryStoreId === "memstore_01"
            ? {
                id: "memstore_01",
                archivedAt: null,
                createdAt: "2026-08-26T11:00:00.000Z",
                name: "User Preferences",
                description: "Personalization facts",
                updatedAt: "2026-08-26T11:00:00.000Z",
              }
            : null,
      },
      ids: { nextResourceId: () => `sesrsc_0${++nextId}` },
    });

    const result = await resolver.resolve({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      createdAt: "2026-08-26T12:00:00.000Z",
      resources: [
        { type: "file", fileId: "file_01" },
        {
          type: "github_repository",
          authorizationToken: "ghp_create",
          url: "https://github.com/openma-ai/open-managed-agents.git",
          checkout: { type: "branch", name: "main" },
        },
        {
          type: "memory_store",
          memoryStoreId: "memstore_01",
          access: "read_only",
          instructions: "Use only when relevant",
        },
      ],
    });

    expect(result).toEqual({
      type: "resolved",
      resources: [
        {
          id: "sesrsc_01",
          type: "file",
          createdAt: "2026-08-26T12:00:00.000Z",
          fileId: "file_01",
          mountPath: "/mnt/session/uploads/file_01",
          updatedAt: "2026-08-26T12:00:00.000Z",
        },
        {
          id: "sesrsc_02",
          type: "github_repository",
          checkout: { type: "branch", name: "main" },
          createdAt: "2026-08-26T12:00:00.000Z",
          mountPath: "/workspace/open-managed-agents",
          updatedAt: "2026-08-26T12:00:00.000Z",
          url: "https://github.com/openma-ai/open-managed-agents.git",
        },
        {
          type: "memory_store",
          memoryStoreId: "memstore_01",
          access: "read_only",
          description: "Personalization facts",
          instructions: "Use only when relevant",
          mountPath: "/mnt/memory/user-preferences",
          name: "User Preferences",
        },
      ],
      secrets: [
        {
          type: "github_token",
          resourceId: "sesrsc_02",
          authorizationToken: "ghp_create",
        },
      ],
    });
  });
});
