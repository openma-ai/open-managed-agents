import { beforeEach, describe, expect, it } from "vitest";
import type { EnvironmentRecord } from "@open-managed-agents/environment-store";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlEnvironmentStore } from "../src/index";

const schema = `
CREATE TABLE managed_environments (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);`;

function environment(id: string, createdAt: string): EnvironmentRecord {
  return {
    id,
    archivedAt: null,
    config: { type: "self_hosted" },
    createdAt,
    description: null,
    metadata: {},
    name: id,
    updatedAt: createdAt,
  };
}

describe("SqlEnvironmentStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(schema);
  });

  it("implements tenant-scoped CAS and list semantics", async () => {
    const store = new SqlEnvironmentStore(client);
    const first = environment("env_01", "2026-01-01T00:00:00.000Z");
    const second = environment("env_02", "2026-01-02T00:00:00.000Z");
    await store.insert({ workspaceId: "workspace_a", environment: first });
    await store.insert({ workspaceId: "workspace_a", environment: second });
    await store.insert({ workspaceId: "workspace_b", environment: first });

    await expect(store.replace({
      workspaceId: "workspace_a",
      environmentId: first.id,
      expectedRevision: 0,
      next: first,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 1 });
    await expect(store.list({
      workspaceId: "workspace_a",
      limit: 10,
      includeArchived: false,
      position: { createdAt: first.createdAt, environmentId: first.id },
    })).resolves.toEqual([{ environment: second, revision: 1 }]);
    await expect(store.find({
      workspaceId: "workspace_b",
      environmentId: first.id,
    })).resolves.toEqual({ environment: first, revision: 1 });
  });
});
