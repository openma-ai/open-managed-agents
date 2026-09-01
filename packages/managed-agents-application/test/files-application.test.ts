import { describe, expect, it } from "vitest";
import type { FileMetadataView } from "../src/ports/files";
import { FilesApplicationService } from "../src/index";

class InMemoryFilePersistence {
  readonly files = new Map<string, FileMetadataView>();

  async insert(input: {
    workspaceId: string;
    file: FileMetadataView;
  }): Promise<FileMetadataView> {
    this.files.set(`${input.workspaceId}:${input.file.id}`, structuredClone(input.file));
    return structuredClone(input.file);
  }

  async find(input: {
    workspaceId: string;
    fileId: string;
  }): Promise<FileMetadataView | null> {
    const file = this.files.get(`${input.workspaceId}:${input.fileId}`);
    return file === undefined ? null : structuredClone(file);
  }

  async list(input: {
    workspaceId: string;
    limit: number;
    scopeId?: string;
    position?: { fileId: string; direction: "before" | "after" };
  }): Promise<FileMetadataView[]> {
    const ordered = Array.from(this.files.entries())
      .filter(([key]) => key.startsWith(`${input.workspaceId}:`))
      .map(([, file]) => structuredClone(file))
      .filter(
        (file) => input.scopeId === undefined || file.scope?.id === input.scopeId,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      );
    if (input.position === undefined) return ordered.slice(0, input.limit);
    const cursor = ordered.findIndex((file) => file.id === input.position!.fileId);
    if (cursor < 0) return [];
    return input.position.direction === "after"
      ? ordered.slice(cursor + 1, cursor + 1 + input.limit)
      : ordered.slice(0, cursor).slice(-input.limit);
  }

  async delete(input: {
    workspaceId: string;
    fileId: string;
  }): Promise<{ type: "deleted" } | { type: "not_found" }> {
    return this.files.delete(`${input.workspaceId}:${input.fileId}`)
      ? { type: "deleted" }
      : { type: "not_found" };
  }
}

class InMemoryFileContentStore {
  readonly content = new Map<string, Uint8Array>();

  async put(input: {
    workspaceId: string;
    fileId: string;
    content: Uint8Array;
  }): Promise<void> {
    this.content.set(
      `${input.workspaceId}:${input.fileId}`,
      new Uint8Array(input.content),
    );
  }

  async get(input: {
    workspaceId: string;
    fileId: string;
  }): Promise<Uint8Array | null> {
    const content = this.content.get(`${input.workspaceId}:${input.fileId}`);
    return content === undefined ? null : new Uint8Array(content);
  }

  async delete(input: { workspaceId: string; fileId: string }): Promise<void> {
    this.content.delete(`${input.workspaceId}:${input.fileId}`);
  }
}

describe("FilesApplicationService", () => {
  it("stores bytes and metadata without exposing a transport body", async () => {
    const persistence = new InMemoryFilePersistence();
    const content = new InMemoryFileContentStore();
    const service = new FilesApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      content,
      clock: { now: () => new Date("2026-08-26T13:00:00.000Z") },
      ids: { nextFileId: () => "file_01" },
    });

    const uploaded = await service.uploadFile({
      filename: "notes.txt",
      mimeType: "text/plain",
      content: new TextEncoder().encode("hello"),
    });
    const metadata = await service.retrieveFileMetadata({ fileId: "file_01" });
    const downloaded = await service.downloadFile({ fileId: "file_01" });

    expect(uploaded).toEqual({
      type: "uploaded",
      file: {
        id: "file_01",
        createdAt: "2026-08-26T13:00:00.000Z",
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        downloadable: true,
      },
    });
    expect(metadata).toEqual({
      type: "found",
      file: uploaded.type === "uploaded" ? uploaded.file : null,
    });
    expect(downloaded).toEqual({
      type: "found",
      file: {
        content: new TextEncoder().encode("hello"),
        mimeType: "text/plain",
        filename: "notes.txt",
      },
    });
  });

  it("paginates metadata and deletes metadata plus content in tenant scope", async () => {
    let nextId = 0;
    let now = new Date("2026-08-26T13:00:00.000Z");
    const persistence = new InMemoryFilePersistence();
    const content = new InMemoryFileContentStore();
    const service = new FilesApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      content,
      clock: { now: () => now },
      ids: { nextFileId: () => `file_0${++nextId}` },
    });
    await service.uploadFile({
      filename: "first.txt",
      mimeType: "text/plain",
      content: new Uint8Array([1]),
    });
    now = new Date("2026-08-26T14:00:00.000Z");
    await service.uploadFile({
      filename: "second.txt",
      mimeType: "text/plain",
      content: new Uint8Array([2]),
    });

    const first = await service.listFiles({ pageSize: 1 });
    const second = await service.listFiles({
      pageSize: 1,
      afterId: "file_02",
    });
    const deleted = await service.deleteFile({ fileId: "file_02" });
    const missing = await service.deleteFile({ fileId: "file_missing" });

    expect(first).toMatchObject({
      type: "page",
      page: {
        files: [{ id: "file_02" }],
        hasMore: true,
        firstId: "file_02",
        lastId: "file_02",
      },
    });
    expect(second).toMatchObject({
      type: "page",
      page: {
        files: [{ id: "file_01" }],
        hasMore: false,
        firstId: "file_01",
        lastId: "file_01",
      },
    });
    expect(deleted).toEqual({ type: "deleted", fileId: "file_02" });
    expect(missing).toEqual({ type: "not_found" });
    expect(content.content.has("workspace_01:file_02")).toBe(false);
  });
});
