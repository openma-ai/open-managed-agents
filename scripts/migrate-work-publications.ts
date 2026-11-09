/** Cross-shard Work-publication upgrade. Stop legacy publishers and apply 0029
 * to MAIN_DB and every tenant shard first. Run:
 * pnpm tsx scripts/migrate-work-publications.ts --main=<id> --router=<id> --bindings='{"AUTH_DB_00":"id","AUTH_DB_01":"id"}' --publishers-stopped
 * CF_ACCOUNT_ID and CF_API_TOKEN are required. Apply guarded 0030 only after success.
 * No database IDs or credentials are inferred from another deployment. */
import { backfillWorkPublications } from "../packages/environment-work-store-sql/src/work-publication-backfill";
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
    if (!res.ok || !body.success || body.result.length !== 1) {
      throw new Error(`D1 ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
    }
    return body.result[0]!;
  };
  const statement = (sql: string, params: unknown[] = []): SqlStatement => {
    const prepared: SqlStatement = {
      bind: (...next: unknown[]) => statement(sql, next),
      run: async <T>() => {
        const out = await query<T>(sql, params);
        return { results: out.results, meta: { changes: out.meta.changes ?? 0 } } as SqlRunResult<T>;
      },
      first: async <T>() => (await query<T>(sql, params)).results[0] ?? null,
      all: async <T>() => ({ results: (await query<T>(sql, params)).results }) as SqlSelectResult<T>,
    };
    return prepared;
  };
  return {
    prepare: (sql) => statement(sql),
    batch: async () => { throw new Error("D1 HTTP adapter does not expose atomic batches"); },
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

async function main() {
  const args = parseArgs();
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!account || !token || !args.main || !args.router || !args.bindings || args["publishers-stopped"] !== "true") {
    throw new Error("Required: CF_ACCOUNT_ID, CF_API_TOKEN, --main=<id> --router=<id> --bindings=<JSON binding-to-id map> --publishers-stopped");
  }
  const bindings = JSON.parse(args.bindings) as Record<string, string>;
  const source = d1Client(account, token, args.main);
  const router = d1Client(account, token, args.router);
  const result = await backfillWorkPublications(source, async workspaceId => {
    // Unlike request routing, failed directory reads must never fall back.
    const row = await router.prepare("SELECT binding_name FROM tenant_shard WHERE tenant_id = ?").bind(workspaceId).first<{ binding_name: string }>();
    if (row === null) return source; // unmapped tenants canonically live on MAIN_DB
    const id = bindings[row.binding_name];
    if (typeof id !== "string" || !id) throw new Error("Missing database mapping for " + row.binding_name);
    return d1Client(account, token, id);
  });
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Publication migration failed"); process.exitCode = 1; });
