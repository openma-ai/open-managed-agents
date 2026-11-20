// PostgreSQL leg of the KV upsert contract; see helpers/kv-store-upsert.ts.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";

import type { NodeDatabase } from "@open-managed-agents/node-database";
import { openNodeDatabase } from "../src/database.js";
import { runBenchmarkStoreCreateMessages, runKvStoreUpsert } from "./helpers/kv-store-upsert.js";

let container: StartedPostgreSqlContainer;
let database: NodeDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  database = await openNodeDatabase({ kind: "postgres", url: container.getConnectionUri() });
}, 180_000);

afterAll(async () => {
  await database?.stop?.();
  await container?.stop();
}, 60_000);

describe("SqlKvStore upsert on PostgreSQL", () => {
  it("inserts, overwrites and deletes keys", async () => {
    await runKvStoreUpsert(database);
  });

  it("creates a messages eval benchmark (POST /v1/oma/evals/benchmarks path)", async () => {
    await runBenchmarkStoreCreateMessages(database);
  });
});
