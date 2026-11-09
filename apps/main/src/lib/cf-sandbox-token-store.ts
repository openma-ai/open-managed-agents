// The sandbox token store on Cloudflare tenant D1. Issue and session reads
// know the workspace (the fence names it) and go to its tenant database.
// Verification knows only the Session id and the token: the token carries no
// workspace (#561), and there is no global hash index, so `find` asks every
// tenant database at once — MAIN_DB alone on a single-D1 deployment, MAIN_DB
// plus the AUTH_DB_* shards otherwise — each over both token lanes
// (execution attempt, Environment Work claim). A Session row lives in one of them;
// the hash match makes a second hit impossible in practice, and one is
// treated as an error. Any failed shard makes the whole check `unavailable`
// (503): a missing answer must never become a 401.

import type { Env } from "@open-managed-agents/shared";
import type { SandboxTokenStore } from "@open-managed-agents/sandbox-gateway";
import { createSqlGatewaySandboxTokenStore, createSqlSandboxTokenStore } from "@open-managed-agents/sandbox-gateway-sql";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

const isD1 = (value: unknown): value is D1Database =>
  typeof value === "object" && value !== null && typeof (value as { prepare?: unknown }).prepare === "function";

/** Every distinct tenant database binding of this deployment. */
export function cfTenantDatabases(env: Env): D1Database[] {
  const bag = env as unknown as Record<string, unknown>;
  const all = [env.MAIN_DB, ...Object.keys(bag).filter((key) => /^AUTH_DB_\d+$/u.test(key)).sort().map((key) => bag[key])];
  return [...new Set(all.filter(isD1))];
}

export function cfSandboxTokenStore(env: Env): SandboxTokenStore {
  const tenant = async (workspaceId: string) =>
    createSqlSandboxTokenStore(new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId)));
  return {
    async find(input) {
      const results = await Promise.all(cfTenantDatabases(env).map((db) => createSqlGatewaySandboxTokenStore(new CfD1SqlClient(db)).find(input)));
      const sessions = results.filter((found) => found !== null);
      if (sessions.length > 1) {
        // The same Session id in two shards (e.g. a copy left by a tenant
        // move): the one holding this hash (running attempt or held Work
        // claim) decides.
        const holding = sessions.filter((found) => found.attempt !== null);
        if (holding.length > 1) throw new Error(`Session ${input.sessionId} holds this sandbox token in more than one tenant database`);
        return holding[0] ?? sessions[0]!;
      }
      return sessions[0] ?? null;
    },
    findSession: async (input) => (await tenant(input.workspaceId)).findSession(input),
    appendTokenHash: async (input) => (await tenant(input.fence.workspaceId)).appendTokenHash(input),
  };
}
