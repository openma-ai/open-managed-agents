import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { UserProfile } from "@open-managed-agents/managed-agents-application";
import { SqlUserProfilePersistence } from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_user_profiles (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_user_profiles_workspace_created_id
  ON managed_user_profiles (workspace_id, created_at, id);
`;

const profile = (id: string, createdAt: string, name: string): UserProfile => ({
  id,
  createdAt,
  metadata: { owner: "platform" },
  name,
  trustGrants: {},
  updatedAt: createdAt,
});

describe("SqlUserProfilePersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("persists workspace-scoped profiles with optimistic replacement", async () => {
    const persistence = new SqlUserProfilePersistence(client);
    const initial = profile(
      "uprof_01",
      "2026-08-26T18:00:00.000Z",
      "Example Customer",
    );
    await expect(
      persistence.insert({ workspaceId: "workspace_01", profile: initial }),
    ).resolves.toEqual({ profile: initial, revision: 1 });
    await expect(
      persistence.find({
        workspaceId: "workspace_other",
        userProfileId: initial.id,
      }),
    ).resolves.toBeNull();

    const next = {
      ...initial,
      name: "Renamed",
      updatedAt: "2026-08-26T19:00:00.000Z",
    };
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        userProfileId: initial.id,
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { profile: next, revision: 2 },
    });
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        userProfileId: initial.id,
        expectedRevision: 1,
        next: initial,
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("pages in either order without crossing workspace scope", async () => {
    const persistence = new SqlUserProfilePersistence(client);
    const first = profile("uprof_01", "2026-08-26T18:00:00.000Z", "First");
    const second = profile("uprof_02", "2026-08-26T19:00:00.000Z", "Second");
    await persistence.insert({ workspaceId: "workspace_01", profile: first });
    await persistence.insert({ workspaceId: "workspace_01", profile: second });
    await persistence.insert({ workspaceId: "workspace_other", profile: first });

    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        limit: 10,
        order: "asc",
        position: { createdAt: first.createdAt, userProfileId: first.id },
      }),
    ).resolves.toEqual([{ profile: second, revision: 1 }]);
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        limit: 10,
        order: "desc",
        position: { createdAt: second.createdAt, userProfileId: second.id },
      }),
    ).resolves.toEqual([{ profile: first, revision: 1 }]);
  });
});
