// PostgreSQL leg of the budget-cost restart contract; see budget-cost-restart.test.ts.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NodeDatabase } from "@open-managed-agents/node-database";
import { openNodeDatabase } from "../src/database.js";
import { BUDGET_RESTART_EXPECTED, runBudgetCostAcrossRestart } from "./helpers/budget-cost-restart.js";

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

describe("session budget cost across a restart on PostgreSQL", () => {
  it("accumulates list_cost_pico across processes (100 + 100 = 200 cents)", async () => {
    expect(await runBudgetCostAcrossRestart(database.sql)).toEqual(BUDGET_RESTART_EXPECTED);
  });
});
