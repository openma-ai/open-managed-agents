import { describe, expect, it } from "vitest";
import type { Vault } from "../src/domain/vault";
import { VaultsApplicationService } from "../src/index";

interface StoredVault {
  vault: Vault;
  revision: number;
}

class InMemoryVaultPersistence {
  private readonly records = new Map<string, StoredVault>();

  async insert(input: {
    workspaceId: string;
    vault: Vault;
  }): Promise<StoredVault> {
    const record = { vault: structuredClone(input.vault), revision: 1 };
    this.records.set(`${input.workspaceId}:${input.vault.id}`, record);
    return structuredClone(record);
  }

  async find(input: {
    workspaceId: string;
    vaultId: string;
  }): Promise<StoredVault | null> {
    const record = this.records.get(`${input.workspaceId}:${input.vaultId}`);
    return record === undefined ? null : structuredClone(record);
  }

  async replace(input: {
    workspaceId: string;
    vaultId: string;
    expectedRevision: number;
    next: Vault;
  }) {
    const key = `${input.workspaceId}:${input.vaultId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" as const };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict" as const,
        actualRevision: current.revision,
      };
    }
    const record = {
      vault: structuredClone(input.next),
      revision: current.revision + 1,
    };
    this.records.set(key, record);
    return { type: "replaced" as const, record: structuredClone(record) };
  }

  async archive(input: {
    workspaceId: string;
    vaultId: string;
    archivedAt: string;
  }) {
    const key = `${input.workspaceId}:${input.vaultId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" as const };
    const record = {
      vault: {
        ...current.vault,
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    this.records.set(key, structuredClone(record));
    return { type: "archived" as const, record: structuredClone(record) };
  }

  async delete(input: { workspaceId: string; vaultId: string }) {
    return this.records.delete(`${input.workspaceId}:${input.vaultId}`)
      ? { type: "deleted" as const }
      : { type: "not_found" as const };
  }

  async list(input: {
    workspaceId: string;
    limit: number;
    includeArchived: boolean;
    position?: { createdAt: string; vaultId: string };
  }): Promise<StoredVault[]> {
    return Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(`${input.workspaceId}:`))
      .map(([, record]) => record)
      .filter((record) => input.includeArchived || record.vault.archivedAt === null)
      .filter(
        (record) =>
          input.position === undefined ||
          record.vault.createdAt > input.position.createdAt ||
          (record.vault.createdAt === input.position.createdAt &&
            record.vault.id > input.position.vaultId),
      )
      .sort(
        (left, right) =>
          left.vault.createdAt.localeCompare(right.vault.createdAt) ||
          left.vault.id.localeCompare(right.vault.id),
      )
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }
}

describe("VaultsApplicationService", () => {
  it("creates and patches a workspace-scoped Vault with official null semantics", async () => {
    let now = new Date("2026-08-26T18:00:00.000Z");
    const service = new VaultsApplicationService({
      workspaceId: "workspace_01",
      store: new InMemoryVaultPersistence(),
      clock: { now: () => now },
      ids: { nextVaultId: () => "vlt_01" },
    });

    await expect(
      service.createVault({
        displayName: "Production credentials",
        metadata: { owner: "platform", obsolete: "remove" },
      }),
    ).resolves.toMatchObject({
      type: "created",
      vault: {
        id: "vlt_01",
        archivedAt: null,
        displayName: "Production credentials",
      },
    });

    now = new Date("2026-08-26T19:00:00.000Z");
    await expect(
      service.updateVault({
        vaultId: "vlt_01",
        displayName: null,
        metadata: { owner: "runtime", obsolete: null },
      }),
    ).resolves.toEqual({
      type: "updated",
      vault: {
        id: "vlt_01",
        archivedAt: null,
        createdAt: "2026-08-26T18:00:00.000Z",
        displayName: "Production credentials",
        metadata: { owner: "runtime" },
        updatedAt: "2026-08-26T19:00:00.000Z",
      },
    });
  });

  it("paginates, archives, and deletes without weakening expected outcomes", async () => {
    let now = new Date("2026-08-26T18:00:00.000Z");
    let nextId = 0;
    const service = new VaultsApplicationService({
      workspaceId: "workspace_01",
      store: new InMemoryVaultPersistence(),
      clock: { now: () => now },
      ids: { nextVaultId: () => `vlt_0${++nextId}` },
    });
    await service.createVault({ displayName: "First" });
    now = new Date("2026-08-26T19:00:00.000Z");
    await service.createVault({ displayName: "Second" });

    const first = await service.listVaults({ pageSize: 1 });
    if (first.type !== "page") throw new Error("expected Vault page");
    await expect(
      service.listVaults({
        pageSize: 1,
        cursor: first.page.nextCursor ?? undefined,
      }),
    ).resolves.toMatchObject({
      type: "page",
      page: { vaults: [{ id: "vlt_02" }], nextCursor: null },
    });

    now = new Date("2026-08-26T20:00:00.000Z");
    await expect(service.archiveVault({ vaultId: "vlt_01" })).resolves.toMatchObject({
      type: "archived",
      vault: { archivedAt: "2026-08-26T20:00:00.000Z" },
    });
    await expect(service.deleteVault({ vaultId: "vlt_01" })).resolves.toEqual({
      type: "deleted",
      vaultId: "vlt_01",
    });
  });
});
