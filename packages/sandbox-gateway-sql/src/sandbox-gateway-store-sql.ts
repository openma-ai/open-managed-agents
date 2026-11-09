// The fence-bound SandboxGatewayStore over one workspace's SqlClient: the
// execution lease (managed_session_executions) and the Session record.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SandboxGatewayStore } from "@open-managed-agents/sandbox-gateway";
import { createSqlSessionExecutionLeases } from "@open-managed-agents/session-runtime-sql/execution-lease";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";

export function createSqlSandboxGatewayStore(sql: SqlClient): SandboxGatewayStore {
  const sessions = new SqlSessionSource(sql);
  return {
    leases: createSqlSessionExecutionLeases(sql),
    findSession: (input) => sessions.find(input),
  };
}
