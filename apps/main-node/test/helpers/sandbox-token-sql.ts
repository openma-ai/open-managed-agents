// The sandbox token store suite on PostgreSQL / MySQL (testcontainers), over
// the real migrated schema (openNodeDatabase runs the dialect's migrations,
// including the sandbox_token_hashes column of this change).
import { SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql/coordination";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { createSqlSandboxGatewayStore, createSqlSandboxTokenStore } from "../../../../packages/sandbox-gateway-sql/src/index";
import { seedSandboxGatewaySessionRows } from "../../../../packages/sandbox-gateway/test/gateway-store-conformance";
import { gatedSql, type SandboxTokenStoreTestHarness } from "../../../../packages/sandbox-gateway/test/sandbox-token-store-conformance";

export function sandboxTokenHarness(raw: () => SqlClient, run: string): SandboxTokenStoreTestHarness {
  return {
    async withStore(fixtureId, body) {
      const base = raw();
      const { sql, gate } = gatedSql(base);
      const workspaceId = `ws_${fixtureId}_${run}`.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 100);
      return body({
        workspaceId, gate, raw: base, gatewayStore: createSqlSandboxGatewayStore(sql),
        store: createSqlSandboxTokenStore(sql),
        executions: new SqlSessionExecutionCoordinator(base),
        seedSession: (session) => seedSandboxGatewaySessionRows(base, workspaceId, session),
        setTokenColumn: async (executionId, value) => {
          await base.prepare("UPDATE managed_session_executions SET sandbox_token_hashes = ? WHERE workspace_id = ? AND id = ?").bind(value, workspaceId, executionId).run();
        },
        archive: async (sessionId, atMs) => {
          await base.prepare("UPDATE managed_sessions SET archived_at = ? WHERE workspace_id = ? AND id = ?").bind(atMs, workspaceId, sessionId).run();
        },
      });
    },
  };
}
