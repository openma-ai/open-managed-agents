/**
 * Move agents from the legacy `agents` / `agent_versions` tables of one D1
 * database into `managed_agents` / `managed_agent_versions`.
 *
 * Run it on every D1 database that holds agents before applying migration
 * 0024_drop_legacy_agents, which refuses to drop tables that still have rows.
 * Node deployments do not need it: main-node moves the rows itself on start.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-legacy-agents.ts --db=<d1-database-id>
 * Required env (or flags --account / --token): CF_ACCOUNT_ID, CF_API_TOKEN.
 *
 * The D1 HTTP API runs one statement per request, so a batch is not atomic
 * here. Each agent is written to the managed tables before its legacy rows
 * are deleted, so rerunning after an interruption completes the move.
 */

import { migrateLegacyAgents } from "../packages/agent-store-sql/src/legacy-agents-migration";
import type { SqlClient, SqlRunResult, SqlSelectResult, SqlStatement } from "../packages/sql-client/src/ports";

interface CfApiResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ message: string }>;
}

function d1Client(accountId: string, token: string, databaseId: string): SqlClient {
  const query = async <T>(sql: string, params: unknown[]): Promise<{ results: T[]; meta: { changes?: number } }> => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ sql, params }),
      },
    );
    const body = (await res.json()) as CfApiResponse<Array<{ results: T[]; meta: { changes?: number } }>>;
    if (!body.success) {
      throw new Error(`D1 ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
    }
    return body.result[0] ?? { results: [], meta: {} };
  };
  const statement = (sql: string, params: unknown[] = []): SqlStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async <T>() => {
      const out = await query<T>(sql, params);
      return { results: out.results, meta: { changes: out.meta.changes ?? 0 } } as SqlRunResult<T>;
    },
    first: async <T>() => (await query<T>(sql, params)).results[0] ?? null,
    all: async <T>() => ({ results: (await query<T>(sql, params)).results }) as SqlSelectResult<T>,
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async <T>(stmts: SqlStatement[]) => {
      const out: Array<SqlRunResult<T>> = [];
      for (const stmt of stmts) out.push((await stmt.run<T>()));
      return out;
    },
    exec: async (sql) => {
      await query(sql, []);
    },
  };
}

function parseArgs(): Record<string, string> {
  return Object.fromEntries(
    process.argv
      .slice(2)
      .filter((arg) => arg.startsWith("--"))
      .map((arg) => {
        const [key, value] = arg.slice(2).split("=");
        return [key!, value ?? "true"];
      }),
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const accountId = args.account ?? process.env.CF_ACCOUNT_ID;
  const token = args.token ?? process.env.CF_API_TOKEN;
  const databaseId = args.db;
  if (!accountId || !token || !databaseId) {
    console.error(
      "Usage: pnpm tsx scripts/migrate-legacy-agents.ts --db=<d1-database-id>\n" +
        "Required env (or flags): CF_ACCOUNT_ID, CF_API_TOKEN",
    );
    process.exit(1);
  }
  const sql = d1Client(accountId, token, databaseId);
  const exists = await sql
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agents'")
    .first();
  if (!exists) {
    console.log(`[${databaseId}] no legacy agents table; nothing to move`);
    return;
  }
  const moved = await migrateLegacyAgents(sql);
  console.log(`[${databaseId}] moved ${moved} agent(s) to managed_agents`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
