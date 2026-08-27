import { describe, expect, it } from "vitest";
import { MemoryFileStore } from "@open-managed-agents/file-store-memory";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  fileContentStorePort,
  fileStorePort,
  filesModule,
} from "../src/modules/files";

describe("Files application module", () => {
  it("uploads and downloads through workspace-scoped Store Ports", async () => {
    const content = new Map<string, Uint8Array>();
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => `${namespace}_01`,
        }),
        providePort(fileStorePort, new MemoryFileStore()),
        providePort(fileContentStorePort, {
          put: async ({ workspaceId, fileId, content: bytes }) => {
            content.set(`${workspaceId}:${fileId}`, new Uint8Array(bytes));
          },
          get: async ({ workspaceId, fileId }) =>
            content.get(`${workspaceId}:${fileId}`) ?? null,
          delete: async ({ workspaceId, fileId }) => {
            content.delete(`${workspaceId}:${fileId}`);
          },
        }),
        filesModule(),
      ],
    });
    const files = app.port(managedAgentsPortTokens.files);

    await expect(files.uploadFile({
      filename: "notes.txt",
      mimeType: "text/plain",
      content: new TextEncoder().encode("hello"),
    })).resolves.toMatchObject({
      type: "uploaded",
      file: { id: "file_01", filename: "notes.txt", sizeBytes: 5 },
    });
    await expect(files.downloadFile({ fileId: "file_01" })).resolves.toEqual({
      type: "found",
      file: {
        content: new TextEncoder().encode("hello"),
        mimeType: "text/plain",
        filename: "notes.txt",
      },
    });
    expect(content.has("workspace_01:file_01")).toBe(true);
  });
});
