import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../test-worker";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import {
  SqlMemoryStorePersistence,
  SqlMemoryStoreSource,
} from "@open-managed-agents/managed-agents-adapters-sql";
import type { MemoryStore } from "@open-managed-agents/managed-agents-application";

function db(): D1Database {
  return (env as { MAIN_DB: D1Database }).MAIN_DB;
}

const memoryStore: MemoryStore = {
  id: "memstore_d1_contract",
  createdAt: "2026-08-26T19:00:00.000Z",
  name: "D1 memory",
  updatedAt: "2026-08-26T19:00:00.000Z",
  archivedAt: null,
  description: "D1 contract",
};

beforeAll(async () => {
  await worker.fetch(
    new Request("http://localhost/health"),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
});

describe("Managed Memory Store SQL adapters on Cloudflare D1", () => {
  it("uses the deployed isolated table and complete snapshot source", async () => {
    const client = new CfD1SqlClient(db());
    const persistence = new SqlMemoryStorePersistence(client);
    const source = new SqlMemoryStoreSource(client);
    await persistence.insert({
      workspaceId: "workspace_d1_memory_stores",
      memoryStore,
    });

    await expect(
      source.find({
        workspaceId: "workspace_d1_memory_stores",
        memoryStoreId: memoryStore.id,
      }),
    ).resolves.toEqual(memoryStore);
  });
});
