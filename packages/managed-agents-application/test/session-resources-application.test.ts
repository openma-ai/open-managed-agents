import { describe, expect, it } from "vitest";
import type { SessionResource } from "../src/domain/session-resource";
import { SessionResourcesApplicationService } from "../src/index";

interface ResourceRecord {
  resources: SessionResource[];
  revision: number;
}

class InMemorySessionResourcePersistence {
  readonly records = new Map<string, ResourceRecord>();
  readonly secretChanges: object[] = [];

  async findCurrent(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<ResourceRecord | null> {
    const record = this.records.get(`${input.workspaceId}:${input.sessionId}`);
    return record === undefined ? null : structuredClone(record);
  }

  async replaceCurrent(input: {
    workspaceId: string;
    sessionId: string;
    expectedRevision: number;
    resources: SessionResource[];
    updatedAt: string;
    secretChanges: object[];
  }): Promise<
    | { type: "replaced"; record: ResourceRecord }
    | { type: "not_found" }
    | { type: "revision_conflict"; actualRevision: number }
  > {
    const key = `${input.workspaceId}:${input.sessionId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const record = {
      resources: structuredClone(input.resources),
      revision: current.revision + 1,
    };
    this.records.set(key, record);
    this.secretChanges.push(...structuredClone(input.secretChanges));
    return { type: "replaced", record: structuredClone(record) };
  }
}

describe("SessionResourcesApplicationService", () => {
  it("adds a validated file with the official default mount path through CAS", async () => {
    const persistence = new InMemorySessionResourcePersistence();
    persistence.records.set("workspace_01:session_01", {
      resources: [],
      revision: 3,
    });
    const fileLookups: object[] = [];
    const service = new SessionResourcesApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      files: {
        find: async (input: object) => {
          fileLookups.push(input);
          return {
            id: "file_01",
            createdAt: "2026-08-26T09:00:00.000Z",
            filename: "brief.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            downloadable: true,
          };
        },
      },
      clock: { now: () => new Date("2026-08-26T10:00:00.000Z") },
      ids: { nextResourceId: () => "sesrsc_file_01" },
    });

    const result = await service.addSessionFileResource({
      sessionId: "session_01",
      fileId: "file_01",
      mountPath: null,
    });

    expect(fileLookups).toEqual([
      { workspaceId: "workspace_01", fileId: "file_01" },
    ]);
    expect(result).toEqual({
      type: "added",
      resource: {
        id: "sesrsc_file_01",
        type: "file",
        createdAt: "2026-08-26T10:00:00.000Z",
        fileId: "file_01",
        mountPath: "/mnt/session/uploads/file_01",
        updatedAt: "2026-08-26T10:00:00.000Z",
      },
    });
    expect(persistence.records.get("workspace_01:session_01")).toEqual({
      revision: 4,
      resources: [result.type === "added" ? result.resource : null],
    });
    expect(persistence.secretChanges).toEqual([]);
  });

  it("lists and retrieves resource snapshots through an application cursor", async () => {
    const persistence = new InMemorySessionResourcePersistence();
    const resources: SessionResource[] = [
      {
        id: "sesrsc_file_01",
        type: "file",
        createdAt: "2026-08-26T09:00:00.000Z",
        fileId: "file_01",
        mountPath: "/mnt/session/uploads/file_01",
        updatedAt: "2026-08-26T09:00:00.000Z",
      },
      {
        type: "memory_store",
        memoryStoreId: "memstore_01",
        access: "read_only",
        description: "Preferences",
        name: "preferences",
      },
      {
        id: "sesrsc_repo_01",
        type: "github_repository",
        createdAt: "2026-08-26T09:00:00.000Z",
        mountPath: "/workspace/openma",
        updatedAt: "2026-08-26T09:00:00.000Z",
        url: "https://github.com/openma-ai/open-managed-agents",
      },
    ];
    persistence.records.set("workspace_01:session_01", {
      resources,
      revision: 1,
    });
    const service = new SessionResourcesApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      files: { find: async () => null },
      clock: { now: () => new Date("2026-08-26T10:00:00.000Z") },
      ids: { nextResourceId: () => "sesrsc_unused" },
    });

    const first = await service.listSessionResources({
      sessionId: "session_01",
      pageSize: 2,
    });
    if (first.type !== "page") throw new Error("expected resource page");
    const second = await service.listSessionResources({
      sessionId: "session_01",
      pageSize: 2,
      cursor: first.page.nextCursor ?? undefined,
    });
    const retrieved = await service.retrieveSessionResource({
      sessionId: "session_01",
      resourceId: "memstore_01",
    });

    expect(first).toEqual({
      type: "page",
      page: { resources: resources.slice(0, 2), nextCursor: expect.any(String) },
    });
    expect(second).toEqual({
      type: "page",
      page: { resources: resources.slice(2), nextCursor: null },
    });
    expect(retrieved).toEqual({ type: "found", resource: resources[1] });
  });

  it("rotates and deletes a GitHub token in the same CAS as its public snapshot", async () => {
    let now = new Date("2026-08-26T10:00:00.000Z");
    const persistence = new InMemorySessionResourcePersistence();
    persistence.records.set("workspace_01:session_01", {
      revision: 5,
      resources: [
        {
          id: "sesrsc_repo_01",
          type: "github_repository",
          createdAt: "2026-08-26T09:00:00.000Z",
          mountPath: "/workspace/openma",
          updatedAt: "2026-08-26T09:00:00.000Z",
          url: "https://github.com/openma-ai/open-managed-agents",
        },
      ],
    });
    const service = new SessionResourcesApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      files: { find: async () => null },
      clock: { now: () => now },
      ids: { nextResourceId: () => "sesrsc_unused" },
    });

    const updated = await service.updateSessionResource({
      sessionId: "session_01",
      resourceId: "sesrsc_repo_01",
      authorizationToken: "ghp_rotated",
    });
    now = new Date("2026-08-26T11:00:00.000Z");
    const deleted = await service.deleteSessionResource({
      sessionId: "session_01",
      resourceId: "sesrsc_repo_01",
    });

    expect(updated).toMatchObject({
      type: "updated",
      resource: {
        id: "sesrsc_repo_01",
        type: "github_repository",
        updatedAt: "2026-08-26T10:00:00.000Z",
      },
    });
    expect(deleted).toEqual({
      type: "deleted",
      resourceId: "sesrsc_repo_01",
    });
    expect(persistence.secretChanges).toEqual([
      {
        type: "store_github_token",
        resourceId: "sesrsc_repo_01",
        authorizationToken: "ghp_rotated",
      },
      { type: "delete_github_token", resourceId: "sesrsc_repo_01" },
    ]);
    expect(persistence.records.get("workspace_01:session_01")).toEqual({
      resources: [],
      revision: 7,
    });
  });
});
