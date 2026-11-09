import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll } from "vitest";
import type { NodeDatabase } from "@open-managed-agents/node-database";
import { openNodeDatabase } from "../src/database.js";
import { sandboxTokenStoreConformance } from "../../../packages/sandbox-gateway/test/sandbox-token-store-conformance";
import { sandboxTokenRaceConformance } from "../../../packages/sandbox-gateway/test/sandbox-token-race-conformance";
import { sandboxTokenHarness } from "./helpers/sandbox-token-sql";

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

const harness = sandboxTokenHarness(() => database.sql, randomUUID().slice(0, 8));
sandboxTokenStoreConformance("sandbox-gateway-sql (PostgreSQL 16, migrated schema)", harness);
sandboxTokenRaceConformance("sandbox-gateway-sql (PostgreSQL 16, migrated schema)", harness);
