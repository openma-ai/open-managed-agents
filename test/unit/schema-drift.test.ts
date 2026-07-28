// CI guard against drift between the 4 dialect schemas.
//
// Today there are 4 schema sources in packages/db-schema/:
//   src/cf-auth/         → SQLite, applied to AUTH_DB on CF
//   src/cf-integrations/ → SQLite, applied to INTEGRATIONS_DB on CF
//   src/cf-router/       → SQLite, applied to ROUTER_DB on CF
//   src/node-pg/         → PG, the union of all of the above
//
// The PG side is meant to be the union of the three CF sides. If a table
// exists in cf-auth but not in node-pg (or vice versa), or if a column
// disagrees, this test catches it before review.
//
// Implementation: imports drizzle-kit's `meta/0001_snapshot.json` files
// directly via vite's static JSON import. drizzle-kit emits these as the
// canonical machine-readable description of the schema (more reliable
// than re-parsing SQL). No DB engine dep, runs cleanly in CF Workers
// vitest pool.

import { describe, it, expect } from "vitest";
import cfAuthSnap from "../../apps/main/migrations/meta/0000_consolidated_snapshot.json";
import cfIntegrationsSnap from "../../apps/main/migrations-integrations/meta/0001_snapshot.json";
import cfRouterSnap from "../../apps/main/migrations-router/meta/0001_snapshot.json";
import nodePgSnap from "../../apps/main-node/migrations/meta/0000_consolidated_snapshot.json";

interface Snapshot {
  tables: Record<
    string,
    {
      name: string;
      columns: Record<string, { name: string; type: string; notNull?: boolean; primaryKey?: boolean }>;
      indexes?: Record<string, unknown>;
    }
  >;
}

const cfAuth = cfAuthSnap as unknown as Snapshot;
const cfIntegrations = cfIntegrationsSnap as unknown as Snapshot;
const cfRouter = cfRouterSnap as unknown as Snapshot;
const pg = nodePgSnap as unknown as Snapshot;

function tableSet(s: Snapshot): Set<string> {
  // PG snapshots key tables as "public.<name>"; SQLite uses bare name.
  // Normalize to bare for cross-dialect comparison.
  return new Set(Object.keys(s.tables).map((k) => k.replace(/^public\./, "")));
}

function tableEntries(s: Snapshot): [string, Snapshot["tables"][string]][] {
  return Object.entries(s.tables).map(([k, v]) => [k.replace(/^public\./, ""), v]);
}

function loadAllCfTables(): Set<string> {
  const names = new Set<string>();
  for (const s of [cfAuth, cfIntegrations, cfRouter]) {
    for (const t of tableSet(s)) names.add(t);
  }
  return names;
}

describe("Schema drift across dialects", () => {
  // Tables that legitimately appear ONLY on one side. Empty until a
  // genuine reason emerges; every entry needs a comment justifying why
  // CF (or PG) doesn't need it.
  const pgOnly = new Set<string>([]);
  const cfOnly = new Set<string>([]);

  it("CF (cf-auth + cf-integrations + cf-router) and PG cover the same table set", () => {
    const cfTables = loadAllCfTables();
    const pgTables = tableSet(pg);

    const missingFromPg = [...cfTables].filter((t) => !pgTables.has(t) && !cfOnly.has(t)).sort();
    const extraOnPg = [...pgTables].filter((t) => !cfTables.has(t) && !pgOnly.has(t)).sort();

    expect({ missingFromPg, extraOnPg }).toEqual({
      missingFromPg: [],
      extraOnPg: [],
    });
  });

  // Tables with known cross-dialect drift the test should ALLOW for now.
  // Each entry is a real product call to make in a follow-up. Drizzle as
  // single-source-of-truth eventually means this map shrinks to {}.
  // Adding new entries requires the table name + a comment justifying
  // why CF and PG legitimately differ today.
  const knownColumnDrift = new Map<string, { reason: string }>([
    [
      "session_resources",
      {
        reason:
          "CF has a single `config` TEXT JSON blob; PG explodes to 11 typed columns (memory_store_id, mount_path, access, instructions, url, checkout_*, name, value). PG shape is more queryable and was the later design — reconcile by migrating CF to the typed shape.",
      },
    ],
    [
      "model_cards",
      {
        reason:
          "CF has `model` column (added in 0015 rename); PG still has the pre-0015 `display_name`. Add a forward-only PG migration that renames `display_name` → `model` to align.",
      },
    ],
    [
      "workspace_backups",
      {
        reason:
          "CF: (environment_id, backup_handle JSON, source_session_id) — environment-scoped. PG: (session_id, blob_key, size_bytes) — session-scoped. Different product lifecycles. Pick a winner.",
      },
    ],
  ]);

  it("each shared table has the same column set on both dialects", () => {
    // Build a normalized lookup for PG by stripping `public.` prefix.
    const pgByName = new Map<string, Snapshot["tables"][string]>(tableEntries(pg));

    const drift: { table: string; missingOnPg: string[]; extraOnPg: string[]; reason?: string }[] = [];

    for (const cf of [cfAuth, cfIntegrations, cfRouter]) {
      for (const [name, table] of tableEntries(cf)) {
        if (cfOnly.has(name)) continue;
        const pgTable = pgByName.get(name);
        if (!pgTable) continue; // missing-table case covered by prior test
        const cfCols = new Set(Object.keys(table.columns));
        const pgCols = new Set(Object.keys(pgTable.columns));
        const missingOnPg = [...cfCols].filter((c) => !pgCols.has(c)).sort();
        const extraOnPg = [...pgCols].filter((c) => !cfCols.has(c)).sort();
        if (missingOnPg.length > 0 || extraOnPg.length > 0) {
          if (knownColumnDrift.has(name)) continue; // allowlisted, see knownColumnDrift map for reason
          drift.push({ table: name, missingOnPg, extraOnPg });
        }
      }
    }

    expect(drift).toEqual([]);
  });

  it("snapshot files exist and parse — guards against accidental deletion", () => {
    // Sanity: every config emitted a snapshot. If someone deletes the
    // meta/ dir or runs `db:generate` against an empty schema, this
    // catches it.
    expect(Object.keys(cfAuth.tables).length).toBeGreaterThan(0);
    expect(Object.keys(cfIntegrations.tables).length).toBeGreaterThan(0);
    expect(Object.keys(cfRouter.tables).length).toBeGreaterThan(0);
    expect(Object.keys(pg.tables).length).toBeGreaterThan(0);
  });
});
