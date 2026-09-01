import { describe, expect, it } from "vitest";
import type { Environment } from "../src/domain/environment";
import { EnvironmentsApplicationService } from "../src/index";

interface StoredEnvironment {
  environment: Environment;
  revision: number;
}

class InMemoryEnvironmentPersistence {
  private readonly records = new Map<string, StoredEnvironment>();

  async insert(input: {
    workspaceId: string;
    environment: Environment;
  }): Promise<StoredEnvironment> {
    const record = { environment: structuredClone(input.environment), revision: 1 };
    this.records.set(`${input.workspaceId}:${input.environment.id}`, record);
    return structuredClone(record);
  }

  async find(input: {
    workspaceId: string;
    environmentId: string;
  }): Promise<StoredEnvironment | null> {
    const record = this.records.get(`${input.workspaceId}:${input.environmentId}`);
    return record === undefined ? null : structuredClone(record);
  }

  async replace(input: {
    workspaceId: string;
    environmentId: string;
    expectedRevision: number;
    next: Environment;
  }) {
    const key = `${input.workspaceId}:${input.environmentId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" as const };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict" as const,
        actualRevision: current.revision,
      };
    }
    const record = { environment: structuredClone(input.next), revision: current.revision + 1 };
    this.records.set(key, record);
    return { type: "replaced" as const, record: structuredClone(record) };
  }

  async archive(input: {
    workspaceId: string;
    environmentId: string;
    archivedAt: string;
  }) {
    const key = `${input.workspaceId}:${input.environmentId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" as const };
    const record = {
      environment: {
        ...current.environment,
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    this.records.set(key, structuredClone(record));
    return { type: "archived" as const, record: structuredClone(record) };
  }

  async delete(input: { workspaceId: string; environmentId: string }) {
    return this.records.delete(`${input.workspaceId}:${input.environmentId}`)
      ? { type: "deleted" as const }
      : { type: "not_found" as const };
  }

  async list(input: {
    workspaceId: string;
    limit: number;
    includeArchived: boolean;
    position?: { createdAt: string; environmentId: string };
  }): Promise<StoredEnvironment[]> {
    return Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(`${input.workspaceId}:`))
      .map(([, record]) => record)
      .filter((record) => input.includeArchived || record.environment.archivedAt === null)
      .filter(
        (record) =>
          input.position === undefined ||
          record.environment.createdAt > input.position.createdAt ||
          (record.environment.createdAt === input.position.createdAt &&
            record.environment.id > input.position.environmentId),
      )
      .sort(
        (left, right) =>
          left.environment.createdAt.localeCompare(right.environment.createdAt) ||
          left.environment.id.localeCompare(right.environment.id),
      )
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }
}

describe("EnvironmentsApplicationService", () => {
  it("normalizes cloud defaults and applies nullable update fields", async () => {
    let now = new Date("2026-08-26T20:00:00.000Z");
    const service = new EnvironmentsApplicationService({
      workspaceId: "workspace_01",
      store: new InMemoryEnvironmentPersistence(),
      clock: { now: () => now },
      ids: { nextEnvironmentId: () => "env_01" },
    });

    const created = await service.createEnvironment({
      name: "Cloud runner",
      description: "Initial",
      metadata: { owner: "platform", obsolete: "remove" },
      scope: "organization",
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allowMcpServers: true,
          allowedHosts: ["api.example.com"],
        },
        packages: { apt: ["git"], npm: ["tsx"] },
      },
    });
    now = new Date("2026-08-26T21:00:00.000Z");
    const updated = await service.updateEnvironment({
      environmentId: "env_01",
      description: null,
      metadata: { owner: "runtime", obsolete: null },
      name: null,
      scope: null,
    });

    expect(created).toMatchObject({
      type: "created",
      environment: {
        id: "env_01",
        config: {
          type: "cloud",
          networking: {
            type: "limited",
            allowMcpServers: true,
            allowPackageManagers: false,
            allowedHosts: ["api.example.com"],
          },
          packages: {
            apt: ["git"],
            cargo: [],
            gem: [],
            go: [],
            npm: ["tsx"],
            pip: [],
          },
        },
      },
    });
    expect(updated).toMatchObject({
      type: "updated",
      environment: {
        name: "Cloud runner",
        description: null,
        metadata: { owner: "runtime" },
        updatedAt: "2026-08-26T21:00:00.000Z",
      },
    });
    if (updated.type === "updated") {
      expect(updated.environment).not.toHaveProperty("scope");
    }
  });

  it("pages, archives, and deletes inside the workspace", async () => {
    let now = new Date("2026-08-26T20:00:00.000Z");
    let nextId = 0;
    const service = new EnvironmentsApplicationService({
      workspaceId: "workspace_01",
      store: new InMemoryEnvironmentPersistence(),
      clock: { now: () => now },
      ids: { nextEnvironmentId: () => `env_0${++nextId}` },
    });
    await service.createEnvironment({ name: "First" });
    now = new Date("2026-08-26T21:00:00.000Z");
    await service.createEnvironment({ name: "Second", config: { type: "self_hosted" } });

    const first = await service.listEnvironments({ pageSize: 1 });
    if (first.type !== "page") throw new Error("expected environment page");
    await expect(
      service.listEnvironments({ pageSize: 1, cursor: first.page.nextCursor ?? undefined }),
    ).resolves.toMatchObject({
      type: "page",
      page: { environments: [{ id: "env_02" }], nextCursor: null },
    });
    now = new Date("2026-08-26T22:00:00.000Z");
    await expect(service.archiveEnvironment({ environmentId: "env_01" })).resolves.toMatchObject({
      type: "archived",
      environment: { archivedAt: "2026-08-26T22:00:00.000Z" },
    });
    await expect(service.deleteEnvironment({ environmentId: "env_01" })).resolves.toEqual({
      type: "deleted",
      environmentId: "env_01",
    });
  });

  it("keeps an archived environment read-only", async () => {
    const persistence = new InMemoryEnvironmentPersistence();
    const service = new EnvironmentsApplicationService({
      workspaceId: "workspace_01",
      store: persistence,
      clock: { now: () => new Date("2026-08-26T22:00:00.000Z") },
      ids: { nextEnvironmentId: () => "env_01" },
    });
    await service.createEnvironment({ name: "Archived environment" });
    await service.archiveEnvironment({ environmentId: "env_01" });

    await expect(
      service.updateEnvironment({ environmentId: "env_01", name: "forbidden" }),
    ).resolves.toEqual({
      type: "version_conflict",
      message: "Environment env_01 is archived and read-only",
    });
  });
});
