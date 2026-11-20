// MySQL leg of the KV upsert contract; see helpers/kv-store-upsert.ts.

import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { afterAll, beforeAll, describe, it } from "vitest";

import type { NodeDatabase } from "@open-managed-agents/node-database";
import { openNodeDatabase } from "../src/database.js";
import { runBenchmarkStoreCreateMessages, runKvStoreUpsert } from "./helpers/kv-store-upsert.js";

let container: StartedMySqlContainer;
let database: NodeDatabase;

beforeAll(async () => {
  container = await new MySqlContainer("mysql:8.4").start();
  database = await openNodeDatabase({ kind: "mysql", url: container.getConnectionUri() });
}, 180_000);

afterAll(async () => {
  await database?.stop?.();
  await container?.stop();
}, 60_000);

describe("SqlKvStore upsert on MySQL", () => {
  it("inserts, overwrites and deletes keys", async () => {
    await runKvStoreUpsert(database);
  });

  it("creates a messages eval benchmark (POST /v1/oma/evals/benchmarks path)", async () => {
    await runBenchmarkStoreCreateMessages(database);
  });
});
