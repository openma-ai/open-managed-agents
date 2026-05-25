/**
 * Combined test worker: merges main worker routes + agent worker DO classes.
 * Only used in vitest — production has separate workers.
 */

// --- Main worker routes ---
import mainApp from "../apps/main/src/index";

// --- Agent worker DO + harness registration ---
import { registerHarness } from "../apps/agent/src/harness/registry";
import { DefaultHarness } from "../apps/agent/src/harness/default-loop";
registerHarness("default", () => new DefaultHarness());

export { SessionDO } from "../apps/agent/src/runtime/session-do";
export { Sandbox } from "@cloudflare/sandbox";
export { RuntimeRoom } from "../apps/main/src/runtime-room";
export { outbound, outboundByHost } from "../apps/agent/src/outbound";

// --- Migration bootstrap ---
// Apply D1 schema migrations on first request. Necessary because miniflare's
// D1 starts empty and our routes (e.g. /v1/memory_stores) hit memory tables.
// Idempotent: every CREATE uses IF NOT EXISTS, drop is a no-op rerun.
//
// Mirrors what `wrangler d1 migrations apply` does in prod — applies the
// consolidated baseline SQL file. The original 20 historical files live in
// _archive/ for git-blame reference; this test path uses the same single
// 0000_consolidated.sql self-host deploys ship with, plus any post-
// consolidation files added on top (0018_runtime_multi_tenant.sql is the
// first such — see multi-tenant CLI bridge daemon PR).

// @ts-expect-error vitest resolves SQL via ?raw
import authSchema from "../apps/main/migrations/0000_consolidated.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import schema0018 from "../apps/main/migrations/0018_runtime_multi_tenant.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import integrationsSchema from "../apps/main/migrations-integrations/0001_consolidated.sql?raw";
// @ts-expect-error vitest resolves SQL via ?raw
import routerSchema from "../apps/main/migrations-router/0001_consolidated.sql?raw";

const MIGRATIONS_RAW: string[] = [
  authSchema as string,
  schema0018 as string,
];

const INTEGRATIONS_MIGRATIONS_RAW: string[] = [integrationsSchema as string];

const ROUTER_MIGRATIONS_RAW: string[] = [routerSchema as string];

let migrationsApplied = false;
async function ensureMigrations(env: {
  AUTH_DB?: D1Database;
  INTEGRATIONS_DB?: D1Database;
  ROUTER_DB?: D1Database;
}): Promise<void> {
  if (migrationsApplied || !env.AUTH_DB) return;
  await applyMigrations(env.AUTH_DB, MIGRATIONS_RAW, "auth");
  if (env.INTEGRATIONS_DB) {
    await applyMigrations(env.INTEGRATIONS_DB, INTEGRATIONS_MIGRATIONS_RAW, "integrations");
  }
  if (env.ROUTER_DB) {
    await applyMigrations(env.ROUTER_DB, ROUTER_MIGRATIONS_RAW, "router");
  }
  migrationsApplied = true;
}

async function applyMigrations(
  db: D1Database,
  files: string[],
  label: string,
): Promise<void> {
  for (const sql of files) {
    // Strip line-comments so they don't break statement boundaries, then split
    // on `;`. Run each statement individually via prepare().run() — D1.exec()
    // splits on newlines and breaks multi-line CREATE TABLE.
    const stripped = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of stripped.split(";").map((s) => s.trim()).filter(Boolean)) {
      try {
        await db.prepare(stmt).run();
      } catch (e) {
        // Some migration files contain ALTER TABLE DROP COLUMN that may fail
        // on re-run after IF NOT EXISTS makes them no-ops elsewhere — tolerate
        // benign errors but log to surface real schema issues during dev.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no such column|duplicate column|already exists/i.test(msg)) {
          console.error(`[test-migrations:${label}] failed: ${msg}\n  SQL: ${stmt.slice(0, 80)}...`);
        }
      }
    }
  }
}

export default {
  async fetch(req: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    await ensureMigrations(env);
    return mainApp.fetch(req, env, ctx);
  },
};
