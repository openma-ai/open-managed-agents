import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Vault } from "@open-managed-agents/managed-agents-application";
import { SqlVaultPersistence } from "../src";

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

const vault = (id: string, createdAt: string, displayName = "Production"): Vault => ({
  id,
  archivedAt: null,
  createdAt,
  displayName,
  metadata: {},
  updatedAt: createdAt,
});

describe("SqlVaultPersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("persists workspace-scoped Vault snapshots with optimistic replacement", async () => {
    const persistence = new SqlVaultPersistence(client);
    const initial = vault("vlt_01", "2026-08-26T18:00:00.000Z");
    await persistence.insert({ workspaceId: "workspace_01", vault: initial });
    await expect(
      persistence.find({ workspaceId: "workspace_other", vaultId: initial.id }),
    ).resolves.toBeNull();

    const next = {
      ...initial,
      displayName: "Renamed",
      updatedAt: "2026-08-26T19:00:00.000Z",
    };
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        vaultId: initial.id,
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { vault: next, revision: 2 },
    });
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        vaultId: initial.id,
        expectedRevision: 1,
        next: initial,
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("pages, archives, and deletes without crossing the workspace boundary", async () => {
    const persistence = new SqlVaultPersistence(client);
    const first = vault("vlt_01", "2026-08-26T18:00:00.000Z", "First");
    const second = vault("vlt_02", "2026-08-26T19:00:00.000Z", "Second");
    await persistence.insert({ workspaceId: "workspace_01", vault: first });
    await persistence.insert({ workspaceId: "workspace_01", vault: second });
    await persistence.insert({ workspaceId: "workspace_other", vault: first });

    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: false,
        position: { createdAt: first.createdAt, vaultId: first.id },
      }),
    ).resolves.toEqual([{ vault: second, revision: 1 }]);
    await expect(
      persistence.archive({
        workspaceId: "workspace_01",
        vaultId: first.id,
        archivedAt: "2026-08-26T20:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      type: "archived",
      record: { vault: { archivedAt: "2026-08-26T20:00:00.000Z" } },
    });
    await expect(
      persistence.delete({ workspaceId: "workspace_01", vaultId: first.id }),
    ).resolves.toEqual({ type: "deleted" });
    await expect(
      persistence.find({ workspaceId: "workspace_other", vaultId: first.id }),
    ).resolves.not.toBeNull();
  });
});
