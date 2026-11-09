import { randomUUID } from "node:crypto";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { afterAll, beforeAll } from "vitest";
import type { NodeDatabase } from "@open-managed-agents/node-database";
import { openNodeDatabase } from "../src/database.js";
import { sandboxTokenStoreConformance } from "../../../packages/sandbox-gateway/test/sandbox-token-store-conformance";
import { sandboxTokenHarness } from "./helpers/sandbox-token-sql";

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

sandboxTokenStoreConformance("sandbox-gateway-sql (MySQL 8.4, migrated schema)", sandboxTokenHarness(() => database.sql, randomUUID().slice(0, 8)));
