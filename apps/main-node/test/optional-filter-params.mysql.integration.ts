// MySQL leg of the optional-filter parameter contract; see
// optional-filter-params.test.ts for the SQLite leg and shared golden rows.

import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NodeDatabase } from "@open-managed-agents/node-database";
import { openNodeDatabase } from "../src/database.js";
import {
  OPTIONAL_FILTER_SNAPSHOT,
  prepareOptionalFilterSchema,
  probeLegacyIsNullPatterns,
  PROBE_EXPECTED_ROWS,
  runOptionalFilterScenarios,
} from "./helpers/optional-filter-params.js";

let container: StartedMySqlContainer;
let database: NodeDatabase;

beforeAll(async () => {
  container = await new MySqlContainer("mysql:8.4").start();
  database = await openNodeDatabase({ kind: "mysql", url: container.getConnectionUri() });
  await prepareOptionalFilterSchema(database.sql, "mysql");
}, 180_000);

afterAll(async () => {
  await database?.stop?.();
  await container?.stop();
}, 60_000);

describe("optional SQL filter parameters on MySQL", () => {
  it("matches the cross-dialect golden rows for event-store, checkpoint CAS, and coordination filters", async () => {
    expect(await runOptionalFilterScenarios(database.sql)).toEqual(OPTIONAL_FILTER_SNAPSHOT);
  });

  it("records how mysql2 prepared statements treat the retired `? IS NULL` shape", async () => {
    const probes = await probeLegacyIsNullPatterns(database.sql);
    console.log(`[optional-filter] mysql legacy probes ${JSON.stringify(probes)}`);
    // mysql2 execute() binds JS null as MYSQL_TYPE_NULL, so MySQL 8.4 neither
    // errors nor drifts; the 0/1 flag is kept for dialect uniformity.
    for (const [name, probe] of Object.entries(probes)) {
      expect(probe).toEqual({ ok: true, rows: PROBE_EXPECTED_ROWS[name as keyof typeof PROBE_EXPECTED_ROWS], expected: PROBE_EXPECTED_ROWS[name as keyof typeof PROBE_EXPECTED_ROWS] });
    }
  });
});
