import { beforeEach, describe, expect, it } from "vitest";
import type { UserProfile } from "@open-managed-agents/domain/user-profiles";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlUserProfileStore } from "../src/index";

const SCHEMA = `
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

const profile = (id: string, createdAt: string): UserProfile => ({
  id,
  createdAt,
  metadata: { owner: "platform" },
  name: id,
  trustGrants: {},
  updatedAt: createdAt,
});

describe("SqlUserProfileStore", () => {
  let client: SqlClient;
  let store: SqlUserProfileStore;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    store = new SqlUserProfileStore(client);
  });

  it("keeps profiles scoped and replaces under revision CAS", async () => {
    const initial = profile("uprof_01", "2026-08-26T18:00:00.000Z");
    await expect(store.insert({ workspaceId: "scope_01", profile: initial }))
      .resolves.toEqual({ profile: initial, revision: 1 });
    await expect(store.find({
      workspaceId: "scope_other",
      userProfileId: initial.id,
    })).resolves.toBeNull();
    const next = {
      ...initial,
      name: "Renamed",
      updatedAt: "2026-08-26T19:00:00.000Z",
    };
    await expect(store.replace({
      workspaceId: "scope_01",
      userProfileId: initial.id,
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { profile: next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "scope_01",
      userProfileId: initial.id,
      expectedRevision: 1,
      next: initial,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("pages asc and desc using the requested direction", async () => {
    const first = profile("uprof_01", "2026-08-26T18:00:00.000Z");
    const second = profile("uprof_02", "2026-08-26T19:00:00.000Z");
    await store.insert({ workspaceId: "scope_01", profile: first });
    await store.insert({ workspaceId: "scope_01", profile: second });
    await expect(store.list({
      workspaceId: "scope_01",
      limit: 10,
      order: "asc",
      position: { createdAt: first.createdAt, userProfileId: first.id },
    })).resolves.toEqual([{ profile: second, revision: 1 }]);
    await expect(store.list({
      workspaceId: "scope_01",
      limit: 10,
      order: "desc",
      position: { createdAt: second.createdAt, userProfileId: second.id },
    })).resolves.toEqual([{ profile: first, revision: 1 }]);
  });
});
