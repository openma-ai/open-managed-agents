// SQLite leg of the budget-cost restart contract. PostgreSQL and MySQL legs
// (*.postgres/mysql.integration.ts) assert the same expected result.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NodeDatabase } from "@open-managed-agents/node-database";
import { openNodeDatabase } from "../src/database.js";
import { BUDGET_RESTART_EXPECTED, runBudgetCostAcrossRestart } from "./helpers/budget-cost-restart.js";

let dir: string;
let database: NodeDatabase;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oma-budget-restart-sqlite-"));
  database = await openNodeDatabase({ kind: "sqlite", path: join(dir, "oma.db") });
});

afterAll(async () => {
  await database?.stop?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("session budget cost across a restart on SQLite", () => {
  it("accumulates list_cost_pico across processes (100 + 100 = 200 cents)", async () => {
    expect(await runBudgetCostAcrossRestart(database.sql)).toEqual(BUDGET_RESTART_EXPECTED);
  });
});
