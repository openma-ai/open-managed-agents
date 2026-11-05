// SQLite leg of the cross-dialect optional-filter parameter contract. The
// PostgreSQL and MySQL legs (*.postgres/mysql.integration.ts) assert the same
// golden snapshot, so passing all three is row-level parity.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

let dir: string;
let database: NodeDatabase;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oma-optional-filter-sqlite-"));
  database = await openNodeDatabase({ kind: "sqlite", path: join(dir, "oma.db") });
  await prepareOptionalFilterSchema(database.sql, "sqlite");
});

afterAll(async () => {
  await database?.stop?.();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("optional SQL filter parameters on SQLite", () => {
  it("matches the cross-dialect golden rows for event-store, checkpoint CAS, and coordination filters", async () => {
    expect(await runOptionalFilterScenarios(database.sql)).toEqual(OPTIONAL_FILTER_SNAPSHOT);
  });

  it("accepts the retired `? IS NULL` shape (why SQLite-only tests missed 42P18)", async () => {
    const probes = await probeLegacyIsNullPatterns(database.sql);
    console.log(`[optional-filter] sqlite legacy probes ${JSON.stringify(probes)}`);
    for (const [name, probe] of Object.entries(probes)) {
      expect(probe).toEqual({ ok: true, rows: PROBE_EXPECTED_ROWS[name as keyof typeof PROBE_EXPECTED_ROWS], expected: PROBE_EXPECTED_ROWS[name as keyof typeof PROBE_EXPECTED_ROWS] });
    }
  });
});

describe("optional SQL filter static guard", () => {
  it("keeps the PostgreSQL-incompatible `? IS NULL` placeholder shape out of production sources", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const files = execFileSync("git", ["ls-files", "packages/*/src/**", "apps/*/src/**"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/.test(file));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((file) =>
      readFileSync(join(root, file), "utf8").split("\n").flatMap((line, index) =>
        /(?:\?|\$\d+)\s+IS\s+(?:NOT\s+)?NULL\b/i.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
  });
});
