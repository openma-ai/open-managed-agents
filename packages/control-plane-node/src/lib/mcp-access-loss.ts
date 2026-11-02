import {
  createAccessLossRuntime,
  type AccessLossRuntime,
} from "@open-managed-agents/mcp-access-loss";
import type { SqlClient } from "@open-managed-agents/sql-client";

/**
 * Node managed-MCP access-loss runtime. Scope rows and the wakeup table
 * share the control-plane database. Wakeup cancellation is an idempotent
 * status update, so a repeated lost-access result does not error.
 */
export async function createNodeAccessLossRuntime(sql: SqlClient): Promise<AccessLossRuntime> {
  const runtime = createAccessLossRuntime({
    tenantSql: sql,
    integrationsSql: sql,
  });
  await runtime.prepare();
  return runtime;
}
