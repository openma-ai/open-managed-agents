import { beforeEach, describe, expect, it } from "vitest";
import type { Vault } from "@open-managed-agents/domain/vaults";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlVaultStore } from "../src/index";

const SCHEMA_SQL = `
CREATE TABLE managed_vaults (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_vaults_workspace_created_id
  ON managed_vaults (workspace_id, created_at, id);
`;

function vault(id: string, createdAt: string): Vault {
  return {
    id,
    archivedAt: null,
    createdAt,
    displayName: `Vault ${id}`,
    metadata: {},
    updatedAt: createdAt,
  };
}

describe("SqlVaultStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("preserves scoped snapshots, CAS, pagination, archive, and delete", async () => {
    const store = new SqlVaultStore(client);
    const first = vault("vlt_01", "2026-08-26T10:00:00.000Z");
    const second = vault("vlt_02", "2026-08-26T11:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", vault: first });
    await store.insert({ workspaceId: "workspace_01", vault: second });
    await store.insert({ workspaceId: "workspace_02", vault: first });

    const next = {
      ...first,
      displayName: "Renamed",
      updatedAt: "2026-08-26T12:00:00.000Z",
    };
    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: first.id,
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { vault: next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: first.id,
      expectedRevision: 1,
      next,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      position: { createdAt: first.createdAt, vaultId: first.id },
    })).resolves.toEqual([{ vault: second, revision: 1 }]);
    await expect(store.archive({
      workspaceId: "workspace_01",
      vaultId: first.id,
      archivedAt: "2026-08-26T13:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      record: { vault: { archivedAt: "2026-08-26T13:00:00.000Z" } },
    });
    await expect(store.delete({
      workspaceId: "workspace_01",
      vaultId: first.id,
    })).resolves.toEqual({ type: "deleted" });
    await expect(store.find({
      workspaceId: "workspace_02",
      vaultId: first.id,
    })).resolves.toEqual({ vault: first, revision: 1 });
  });
});
