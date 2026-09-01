import { describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "../src/index";

function credential(id: string, createdAt: string) {
  return {
    id,
    archivedAt: null,
    auth: {
      type: "static_bearer" as const,
      token: `${id}-secret`,
      mcpServerUrl: "https://mcp.example.com/sse",
    },
    createdAt,
    metadata: { owner: "platform" },
    updatedAt: createdAt,
    vaultId: "vlt_01",
  };
}

describe("MemoryCredentialStore", () => {
  it("isolates the same Credential ID by workspace and Vault and clones secrets", async () => {
    const store = new MemoryCredentialStore();
    const first = credential("vcrd_01", "2026-08-26T10:00:00.000Z");
    const second = {
      ...credential("vcrd_01", "2026-08-26T11:00:00.000Z"),
      vaultId: "vlt_02",
    };

    await store.insert({ workspaceId: "workspace_01", credential: first });
    await store.insert({ workspaceId: "workspace_02", credential: second });
    first.auth.token = "mutated-after-insert";

    const stored = await store.find({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      credentialId: "vcrd_01",
    });
    expect(stored).toMatchObject({
      revision: 1,
      credential: { auth: { token: "vcrd_01-secret" } },
    });
    expect(await store.find({
      workspaceId: "workspace_01",
      vaultId: "vlt_02",
      credentialId: "vcrd_01",
    })).toBeNull();
    expect(await store.find({
      workspaceId: "workspace_02",
      vaultId: "vlt_02",
      credentialId: "vcrd_01",
    })).toMatchObject({ credential: { vaultId: "vlt_02" } });
  });

  it("uses revision compare-and-swap without losing the current secret", async () => {
    const store = new MemoryCredentialStore();
    const initial = credential("vcrd_01", "2026-08-26T10:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", credential: initial });
    const next = {
      ...initial,
      auth: { ...initial.auth, token: "rotated-secret" },
      updatedAt: "2026-08-26T11:00:00.000Z",
    };

    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      credentialId: "vcrd_01",
      expectedRevision: 1,
      next,
    })).resolves.toMatchObject({
      type: "replaced",
      record: { revision: 2, credential: { auth: { token: "rotated-secret" } } },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      credentialId: "vcrd_01",
      expectedRevision: 1,
      next,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("lists one Vault in ascending cursor order and filters archived records", async () => {
    const store = new MemoryCredentialStore();
    const first = credential("vcrd_01", "2026-08-26T10:00:00.000Z");
    const second = credential("vcrd_02", "2026-08-26T11:00:00.000Z");
    const otherVault = {
      ...credential("vcrd_03", "2026-08-26T12:00:00.000Z"),
      vaultId: "vlt_02",
    };
    await store.insert({ workspaceId: "workspace_01", credential: second });
    await store.insert({ workspaceId: "workspace_01", credential: first });
    await store.insert({ workspaceId: "workspace_01", credential: otherVault });
    await store.archive({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      credentialId: "vcrd_01",
      archivedAt: "2026-08-26T13:00:00.000Z",
    });

    await expect(store.list({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      limit: 10,
      includeArchived: false,
    })).resolves.toMatchObject([{ credential: { id: "vcrd_02" } }]);
    await expect(store.list({
      workspaceId: "workspace_01",
      vaultId: "vlt_01",
      limit: 10,
      includeArchived: true,
      position: {
        createdAt: "2026-08-26T10:00:00.000Z",
        credentialId: "vcrd_01",
      },
    })).resolves.toMatchObject([{ credential: { id: "vcrd_02" } }]);
  });
});
