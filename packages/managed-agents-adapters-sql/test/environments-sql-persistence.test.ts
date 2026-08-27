import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Environment } from "@open-managed-agents/managed-agents-application";
import {
  SqlEnvironmentPersistence,
  SqlSessionEnvironmentSource,
} from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_environments (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_environments_workspace_created_id
  ON managed_environments (workspace_id, created_at, id);
`;

const environment = (
  id: string,
  createdAt: string,
  name = "Cloud runner",
): Environment => ({
  id,
  archivedAt: null,
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
  },
  createdAt,
  description: null,
  metadata: {},
  name,
  updatedAt: createdAt,
});

describe("SqlEnvironmentPersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("persists with CAS and exposes only active tenant-scoped Session dependencies", async () => {
    const persistence = new SqlEnvironmentPersistence(client);
    const source = new SqlSessionEnvironmentSource(client);
    const initial = environment("env_01", "2026-08-26T20:00:00.000Z");
    await persistence.insert({ workspaceId: "workspace_01", environment: initial });
    await expect(
      source.find({ workspaceId: "workspace_01", environmentId: initial.id }),
    ).resolves.toEqual(initial);
    await expect(
      source.find({ workspaceId: "workspace_other", environmentId: initial.id }),
    ).resolves.toBeNull();

    const next = { ...initial, name: "Renamed", updatedAt: "2026-08-26T21:00:00.000Z" };
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        environmentId: initial.id,
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { environment: next, revision: 2 },
    });
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        environmentId: initial.id,
        expectedRevision: 1,
        next: initial,
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("pages, archives, hides archived dependencies, and deletes by tenant", async () => {
    const persistence = new SqlEnvironmentPersistence(client);
    const source = new SqlSessionEnvironmentSource(client);
    const first = environment("env_01", "2026-08-26T20:00:00.000Z", "First");
    const second = environment("env_02", "2026-08-26T21:00:00.000Z", "Second");
    await persistence.insert({ workspaceId: "workspace_01", environment: first });
    await persistence.insert({ workspaceId: "workspace_01", environment: second });
    await persistence.insert({ workspaceId: "workspace_other", environment: first });
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: false,
        position: { createdAt: first.createdAt, environmentId: first.id },
      }),
    ).resolves.toEqual([{ environment: second, revision: 1 }]);
    await persistence.archive({
      workspaceId: "workspace_01",
      environmentId: first.id,
      archivedAt: "2026-08-26T22:00:00.000Z",
    });
    await expect(
      source.find({ workspaceId: "workspace_01", environmentId: first.id }),
    ).resolves.toBeNull();
    await expect(
      persistence.delete({ workspaceId: "workspace_01", environmentId: first.id }),
    ).resolves.toEqual({ type: "deleted" });
    await expect(
      persistence.find({ workspaceId: "workspace_other", environmentId: first.id }),
    ).resolves.not.toBeNull();
  });
});
