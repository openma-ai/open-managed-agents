import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { FileMetadata } from "@open-managed-agents/managed-agents-application";
import { SqlFileMetadataPersistence } from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_files (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  scope_id text,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_files_workspace_created_id
  ON managed_files (workspace_id, created_at, id);
CREATE INDEX idx_managed_files_workspace_scope_created_id
  ON managed_files (workspace_id, scope_id, created_at, id);
`;

function file(id: string, createdAt: string, scopeId?: string): FileMetadata {
  return {
    id,
    createdAt,
    filename: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 1,
    downloadable: true,
    ...(scopeId !== undefined && {
      scope: { type: "session" as const, id: scopeId },
    }),
  };
}

describe("SqlFileMetadataPersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("isolates metadata and implements directional composite pagination", async () => {
    const persistence = new SqlFileMetadataPersistence(client);
    const oldest = file("file_01", "2026-08-26T01:00:00.000Z", "session_01");
    const middle = file("file_02", "2026-08-26T02:00:00.000Z", "session_01");
    const newest = file("file_03", "2026-08-26T03:00:00.000Z");
    for (const value of [oldest, middle, newest]) {
      await persistence.insert({ workspaceId: "workspace_01", file: value });
    }
    await persistence.insert({
      workspaceId: "workspace_other",
      file: file("file_04", "2026-08-26T04:00:00.000Z"),
    });

    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        limit: 10,
        position: { fileId: newest.id, direction: "after" },
      }),
    ).resolves.toEqual([middle, oldest]);
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        limit: 10,
        position: { fileId: oldest.id, direction: "before" },
      }),
    ).resolves.toEqual([newest, middle]);
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        limit: 10,
        scopeId: "session_01",
      }),
    ).resolves.toEqual([middle, oldest]);
    await expect(
      persistence.find({ workspaceId: "workspace_other", fileId: oldest.id }),
    ).resolves.toBeNull();
  });
});
