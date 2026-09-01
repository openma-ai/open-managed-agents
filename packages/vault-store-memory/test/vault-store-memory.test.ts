import { describe, expect, it } from "vitest";
import { MemoryVaultStore } from "../src/index";

function vault(id: string, createdAt: string) {
  return {
    id,
    archivedAt: null,
    createdAt,
    displayName: `Vault ${id}`,
    metadata: { owner: "platform" },
    updatedAt: createdAt,
  };
}

describe("MemoryVaultStore", () => {
  it("isolates the same Vault ID by workspace and returns cloned snapshots", async () => {
    const store = new MemoryVaultStore();
    const first = vault("vlt_01", "2026-08-26T10:00:00.000Z");
    const second = {
      ...vault("vlt_01", "2026-08-26T11:00:00.000Z"),
      displayName: "Other workspace",
    };
    await store.insert({ workspaceId: "workspace_01", vault: first });
    await store.insert({ workspaceId: "workspace_02", vault: second });
    first.metadata.owner = "mutated";

    await expect(store.find({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
    })).resolves.toMatchObject({
      revision: 1,
      vault: { displayName: "Vault vlt_01", metadata: { owner: "platform" } },
    });
    await expect(store.find({
      workspaceId: "workspace_02",
      vaultId: "vlt_01",
    })).resolves.toMatchObject({ vault: { displayName: "Other workspace" } });
  });

  it("replaces with compare-and-swap and reports the current revision", async () => {
    const store = new MemoryVaultStore();
    const initial = vault("vlt_01", "2026-08-26T10:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", vault: initial });
    const next = {
      ...initial,
      displayName: "Renamed",
      updatedAt: "2026-08-26T11:00:00.000Z",
    };

    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { vault: next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      expectedRevision: 1,
      next,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("lists in ascending cursor order and filters archived Vaults", async () => {
    const store = new MemoryVaultStore();
    const first = vault("vlt_01", "2026-08-26T10:00:00.000Z");
    const second = vault("vlt_02", "2026-08-26T11:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", vault: second });
    await store.insert({ workspaceId: "workspace_01", vault: first });
    await store.archive({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      archivedAt: "2026-08-26T12:00:00.000Z",
    });

    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
    })).resolves.toMatchObject([{ vault: { id: "vlt_02" } }]);
    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: true,
      position: {
        createdAt: "2026-08-26T10:00:00.000Z",
        vaultId: "vlt_01",
      },
    })).resolves.toMatchObject([{ vault: { id: "vlt_02" } }]);
  });
});
