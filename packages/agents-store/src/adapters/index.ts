// Adapter wiring for the agents-store. Both CF (D1) and self-host (any
// OmaDb — typically Drizzle-wrapped better-sqlite3 or postgres-js) factories
// live here behind a single SqlAgentRepo class.

export { SqlAgentRepo } from "./sql-agent-repo";

import { SqlAgentRepo } from "./sql-agent-repo";
import { drizzle } from "drizzle-orm/d1";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { Logger } from "../ports";
import { AgentService } from "../service";

/**
 * CF deployment factory. Wraps the D1Database binding in a Drizzle client so
 * the repo stays runtime-agnostic. apps/main + apps/agent + tests call this
 * unchanged — the Drizzle wrapping is an internal detail.
 *
 * The Drizzle client is constructed with no schema dictionary — adapters
 * import table refs directly from `@open-managed-agents/db-schema/cf-auth`
 * and don't use the relational-query API, so the schema generic stays empty.
 */
export function createCfAgentService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): AgentService {
  const drz = drizzle(deps.db);
  return new AgentService({
    repo: new SqlAgentRepo(drz),
    logger: opts?.logger,
  });
}

/**
 * Node deployment factory. Caller passes any {@link OmaDb} — typically a
 * postgres-js or better-sqlite3 Drizzle client built at the composition root.
 *
 * Coexisting in the same file as createCfAgentService means Node consumers
 * (apps/main-node) must include `@cloudflare/workers-types` in their tsconfig
 * to satisfy the D1Database type reference above. Workerd's resolver in
 * @cloudflare/vitest-pool-workers doesn't honour deep package.json subpath
 * exports for workspace packages — splitting cf/sqlite into separate entries
 * was tried and rejected for that reason.
 */
export function createSqliteAgentService(
  deps: { db: OmaDb },
  opts?: { logger?: Logger },
): AgentService {
  return new AgentService({
    repo: new SqlAgentRepo(deps.db),
    logger: opts?.logger,
  });
}
