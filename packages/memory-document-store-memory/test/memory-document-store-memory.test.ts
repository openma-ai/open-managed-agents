import { describe, expect, it } from "vitest";
import type {
  Memory,
  MemoryVersion,
} from "@open-managed-agents/domain/memories";
import { InMemoryMemoryDocumentStore } from "../src/index";

function memory(
  id: string,
  versionId: string,
  path: string,
  createdAt = "2026-08-26T18:00:00.000Z",
): Memory {
  return {
    id,
    content: "hello",
    contentSha256: "a".repeat(64),
    contentSizeBytes: 5,
    createdAt,
    memoryStoreId: "memstore_01",
    memoryVersionId: versionId,
    path,
    updatedAt: createdAt,
  };
}

function version(
  value: Memory,
  operation: MemoryVersion["operation"] = "created",
): MemoryVersion {
  return {
    id: value.memoryVersionId,
    content: value.content,
    contentSha256: value.contentSha256,
    contentSizeBytes: value.contentSizeBytes,
    createdAt: value.updatedAt,
    createdBy: { kind: "api", apiKeyId: "apikey_01" },
    memoryId: value.id,
    memoryStoreId: value.memoryStoreId,
    operation,
    path: value.path,
    redactedAt: null,
  };
}

describe("InMemoryMemoryDocumentStore", () => {
  it("atomically creates detached current state and history with scoped path uniqueness", async () => {
    const store = new InMemoryMemoryDocumentStore();
    const first = memory("mem_01", "memver_01", "/notes/one.md");

    await expect(store.create({
      workspaceId: "workspace_01",
      memory: first,
      version: version(first),
    })).resolves.toEqual({
      type: "created",
      memory: { memory: first, revision: 1 },
      version: { version: version(first), revision: 1 },
    });
    first.content = "mutated outside";
    await expect(store.findCurrent({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: "mem_01",
    })).resolves.toMatchObject({ memory: { content: "hello" } });
    await expect(store.findCurrent({
      workspaceId: "workspace_other",
      memoryStoreId: "memstore_01",
      memoryId: "mem_01",
    })).resolves.toBeNull();

    const duplicate = memory("mem_02", "memver_02", "/notes/one.md");
    await expect(store.create({
      workspaceId: "workspace_01",
      memory: duplicate,
      version: version(duplicate),
    })).resolves.toEqual({
      type: "path_conflict",
      conflictingMemoryId: "mem_01",
      conflictingPath: "/notes/one.md",
    });
    await expect(store.findVersion({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryVersionId: "memver_02",
    })).resolves.toBeNull();
  });

  it("replaces under CAS and appends the matching version atomically", async () => {
    const store = new InMemoryMemoryDocumentStore();
    const initial = memory("mem_01", "memver_01", "/notes/one.md");
    await store.create({
      workspaceId: "workspace_01",
      memory: initial,
      version: version(initial),
    });
    const next = {
      ...initial,
      content: "updated",
      contentSha256: "b".repeat(64),
      contentSizeBytes: 7,
      memoryVersionId: "memver_02",
      path: "/notes/two.md",
      updatedAt: "2026-08-26T19:00:00.000Z",
    } satisfies Memory;

    await expect(store.replace({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: "mem_01",
      expectedRevision: 1,
      next,
      version: version(next, "modified"),
    })).resolves.toMatchObject({
      type: "replaced",
      memory: { revision: 2, memory: next },
      version: { revision: 1 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: "mem_01",
      expectedRevision: 1,
      next: { ...next, memoryVersionId: "memver_orphan" },
      version: version(
        { ...next, memoryVersionId: "memver_orphan" },
        "modified",
      ),
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.findVersion({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryVersionId: "memver_orphan",
    })).resolves.toBeNull();
  });

  it("rolls up prefixes in stable path order and pages after the exact item kind", async () => {
    const store = new InMemoryMemoryDocumentStore();
    const values = [
      memory("mem_01", "memver_01", "/notes/a.md"),
      memory("mem_02", "memver_02", "/notes/deeper/b.md"),
      memory("mem_03", "memver_03", "/notes/z.md"),
    ];
    for (const value of values) {
      await store.create({
        workspaceId: "workspace_01",
        memory: value,
        version: version(value),
      });
    }

    await expect(store.listCurrent({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      limit: 2,
      depth: 1,
      pathPrefix: "/notes/",
    })).resolves.toEqual({
      items: [
        { kind: "memory", record: { memory: values[0], revision: 1 } },
        { kind: "prefix", path: "/notes/deeper/" },
      ],
      hasMore: true,
    });
    await expect(store.listCurrent({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      limit: 2,
      depth: 1,
      pathPrefix: "/notes/",
      position: { kind: "prefix", path: "/notes/deeper/" },
    })).resolves.toEqual({
      items: [{
        kind: "memory",
        record: { memory: values[2], revision: 1 },
      }],
      hasMore: false,
    });
  });

  it("deletes current state while retaining its terminal version history", async () => {
    const store = new InMemoryMemoryDocumentStore();
    const current = memory("mem_01", "memver_01", "/notes/one.md");
    await store.create({
      workspaceId: "workspace_01",
      memory: current,
      version: version(current),
    });
    const terminalMemory = {
      ...current,
      memoryVersionId: "memver_02",
      updatedAt: "2026-08-26T20:00:00.000Z",
    };
    const terminal = version(terminalMemory, "deleted");

    await expect(store.delete({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: "mem_01",
      expectedRevision: 1,
      version: terminal,
    })).resolves.toEqual({
      type: "deleted",
      version: { version: terminal, revision: 1 },
    });
    await expect(store.findCurrent({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: "mem_01",
    })).resolves.toBeNull();
    await expect(store.findVersion({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryVersionId: "memver_02",
    })).resolves.toEqual({ version: terminal, revision: 1 });
  });

  it("lists version history by inclusive filters and redacts content under CAS", async () => {
    const store = new InMemoryMemoryDocumentStore();
    const first = memory(
      "mem_01",
      "memver_01",
      "/notes/one.md",
      "2026-08-26T18:00:00.000Z",
    );
    const second = memory(
      "mem_02",
      "memver_02",
      "/notes/two.md",
      "2026-08-26T19:00:00.000Z",
    );
    await store.create({
      workspaceId: "workspace_01",
      memory: first,
      version: version(first),
    });
    await store.create({
      workspaceId: "workspace_01",
      memory: second,
      version: version(second),
    });

    await expect(store.listVersions({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      limit: 10,
      apiKeyId: "apikey_01",
      createdAtOrAfter: first.createdAt,
      createdAtOrBefore: second.createdAt,
    })).resolves.toEqual([
      { version: version(second), revision: 1 },
      { version: version(first), revision: 1 },
    ]);
    await expect(store.listVersions({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      limit: 10,
      apiKeyId: "apikey_01",
      serviceAccountId: "service_01",
    })).resolves.toEqual([]);
    await expect(store.redactVersion({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryVersionId: "memver_01",
      expectedRevision: 1,
      redactedAt: "2026-08-26T20:00:00.000Z",
      redactedBy: { kind: "user", userId: "user_01" },
    })).resolves.toMatchObject({
      type: "redacted",
      record: {
        revision: 2,
        version: {
          content: null,
          contentSha256: null,
          contentSizeBytes: null,
          path: null,
          redactedAt: "2026-08-26T20:00:00.000Z",
          redactedBy: { kind: "user", userId: "user_01" },
        },
      },
    });
    await expect(store.redactVersion({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryVersionId: "memver_01",
      expectedRevision: 1,
      redactedAt: "2026-08-26T21:00:00.000Z",
      redactedBy: { kind: "user", userId: "user_02" },
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });
});
