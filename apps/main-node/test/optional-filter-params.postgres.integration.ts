// PostgreSQL leg of the optional-filter parameter contract; see
// optional-filter-params.test.ts for the SQLite leg and shared golden rows.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
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

let container: StartedPostgreSqlContainer;
let database: NodeDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  database = await openNodeDatabase({ kind: "postgres", url: container.getConnectionUri() });
  await prepareOptionalFilterSchema(database.sql, "postgres");
}, 180_000);

afterAll(async () => {
  await database?.stop?.();
  await container?.stop();
}, 60_000);

describe("optional SQL filter parameters on PostgreSQL", () => {
  it("matches the cross-dialect golden rows for event-store, checkpoint CAS, and coordination filters", async () => {
    expect(await runOptionalFilterScenarios(database.sql)).toEqual(OPTIONAL_FILTER_SNAPSHOT);
  });

  it("rejects the retired `? IS NULL` shape with 42P18 for null and non-null binds", async () => {
    const probes = await probeLegacyIsNullPatterns(database.sql);
    console.log(`[optional-filter] postgres legacy probes ${JSON.stringify(probes)}`);
    for (const [name, probe] of Object.entries(probes)) {
      expect(probe).toMatchObject({ ok: false, expected: PROBE_EXPECTED_ROWS[name as keyof typeof PROBE_EXPECTED_ROWS] });
      if (!probe.ok) expect(probe.message).toMatch(/could not determine data type of parameter \$1/);
    }
  });
});
