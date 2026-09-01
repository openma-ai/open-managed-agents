import { describe, expect, it } from "vitest";
import type { FileRecord } from "@open-managed-agents/file-store";
import { MemoryFileStore } from "../src/index";

function file(
  id: string,
  createdAt: string,
  filename = `${id}.txt`,
  scopeId?: string,
): FileRecord {
  return {
    id,
    createdAt,
    filename,
    mimeType: "text/plain",
    sizeBytes: 1,
    downloadable: true,
    ...(scopeId === undefined
      ? {}
      : { scope: { type: "session" as const, id: scopeId } }),
  };
}

describe("MemoryFileStore", () => {
  it("isolates identical file IDs by workspace and returns snapshots", async () => {
    const store = new MemoryFileStore();
    const inA = file("file_shared", "2026-08-26T01:00:00.000Z", "a.txt");
    const inB = file("file_shared", "2026-08-26T02:00:00.000Z", "b.txt");
    await store.insert({ workspaceId: "workspace_a", file: inA });
    await store.insert({ workspaceId: "workspace_b", file: inB });

    const found = await store.find({
      workspaceId: "workspace_a",
      fileId: "file_shared",
    });
    expect(found).toEqual(inA);
    if (found !== null) found.filename = "mutated.txt";
    await expect(store.find({
      workspaceId: "workspace_a",
      fileId: "file_shared",
    })).resolves.toEqual(inA);
    await expect(store.find({
      workspaceId: "workspace_b",
      fileId: "file_shared",
    })).resolves.toEqual(inB);
  });

  it("implements scoped newest-first and directional composite pagination", async () => {
    const store = new MemoryFileStore();
    const oldest = file(
      "file_01",
      "2026-08-26T01:00:00.000Z",
      "oldest.txt",
      "session_01",
    );
    const middle = file(
      "file_02",
      "2026-08-26T02:00:00.000Z",
      "middle.txt",
      "session_01",
    );
    const newest = file("file_03", "2026-08-26T03:00:00.000Z");
    for (const value of [oldest, middle, newest]) {
      await store.insert({ workspaceId: "workspace_a", file: value });
    }

    await expect(store.list({
      workspaceId: "workspace_a",
      limit: 10,
      position: { fileId: newest.id, direction: "after" },
    })).resolves.toEqual([middle, oldest]);
    await expect(store.list({
      workspaceId: "workspace_a",
      limit: 10,
      position: { fileId: oldest.id, direction: "before" },
    })).resolves.toEqual([newest, middle]);
    await expect(store.list({
      workspaceId: "workspace_a",
      limit: 10,
      scopeId: "session_01",
    })).resolves.toEqual([middle, oldest]);
  });

  it("deletes only the selected workspace record", async () => {
    const store = new MemoryFileStore();
    const shared = file("file_shared", "2026-08-26T01:00:00.000Z");
    await store.insert({ workspaceId: "workspace_a", file: shared });
    await store.insert({ workspaceId: "workspace_b", file: shared });

    await expect(store.delete({
      workspaceId: "workspace_a",
      fileId: shared.id,
    })).resolves.toEqual({ type: "deleted" });
    await expect(store.find({
      workspaceId: "workspace_a",
      fileId: shared.id,
    })).resolves.toBeNull();
    await expect(store.find({
      workspaceId: "workspace_b",
      fileId: shared.id,
    })).resolves.toEqual(shared);
  });
});
