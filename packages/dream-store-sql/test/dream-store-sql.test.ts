import { beforeEach, describe, expect, it } from "vitest";
import type { Dream } from "@open-managed-agents/domain/dreams";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlDreamStore } from "../src/index";

const SCHEMA = `
CREATE TABLE managed_dreams (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL,
  created_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_dreams_workspace_created_id
  ON managed_dreams (workspace_id, created_at, id);
`;

const dream = {
  id: "dream_01",
  archivedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  endedAt: null,
  error: null,
  inputs: [
    { kind: "memory_store", memoryStoreId: "memstore_01" },
    { kind: "sessions", sessionIds: ["session_01"] },
  ],
  instructions: "Keep durable decisions",
  model: { modelId: "claude-opus-5", speed: "fast" },
  outputBehavior: { kind: "create_new" },
  outputs: [],
  sessionId: null,
  status: "pending",
  usage: {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  },
} satisfies Dream;

describe("SqlDreamStore", () => {
  let client: SqlClient;
  let store: SqlDreamStore;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    store = new SqlDreamStore(client);
  });

  it("stores, retrieves, and filters complete workspace-scoped aggregates", async () => {
    await expect(store.insert({ workspaceId: "workspace_01", dream }))
      .resolves.toEqual({ dream, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_01",
      dreamId: dream.id,
    })).resolves.toEqual({ dream, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_other",
      dreamId: dream.id,
    })).resolves.toBeNull();
    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 10,
      statuses: ["pending"],
      createdAfter: "2026-08-26T08:59:59.000Z",
      createdBefore: "2026-08-26T09:00:01.000Z",
    })).resolves.toEqual([{ dream, revision: 1 }]);
  });

  it("replaces the entire aggregate under optimistic concurrency", async () => {
    await store.insert({ workspaceId: "workspace_01", dream });
    const completed = {
      ...dream,
      endedAt: "2026-08-26T09:30:00.000Z",
      outputs: [{ kind: "memory_store", memoryStoreId: "memstore_02" }],
      status: "completed",
    } satisfies Dream;

    await expect(store.replace({
      workspaceId: "workspace_01",
      dreamId: dream.id,
      expectedRevision: 1,
      next: completed,
    })).resolves.toEqual({
      type: "replaced",
      record: { dream: completed, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      dreamId: dream.id,
      expectedRevision: 1,
      next: dream,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });
});
