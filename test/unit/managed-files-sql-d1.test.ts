import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../test-worker";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlFileMetadataPersistence } from "@open-managed-agents/managed-agents-adapters-sql";
import type { FileMetadata } from "@open-managed-agents/managed-agents-application";

function db(): D1Database {
  return (env as { MAIN_DB: D1Database }).MAIN_DB;
}

const file: FileMetadata = {
  id: "file_d1_contract",
  createdAt: "2026-08-26T14:00:00.000Z",
  filename: "contract.txt",
  mimeType: "text/plain",
  sizeBytes: 8,
  downloadable: true,
};

beforeAll(async () => {
  await worker.fetch(
    new Request("http://localhost/health"),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
});

describe("SqlFileMetadataPersistence on Cloudflare D1", () => {
  it("inserts and resolves metadata on the deployed migration schema", async () => {
    const persistence = new SqlFileMetadataPersistence(new CfD1SqlClient(db()));
    await persistence.insert({ workspaceId: "workspace_d1_files", file });
    await expect(
      persistence.find({
        workspaceId: "workspace_d1_files",
        fileId: file.id,
      }),
    ).resolves.toEqual(file);
  });
});
