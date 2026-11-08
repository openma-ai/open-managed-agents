// SQL adapter for @open-managed-agents/sandbox-gateway: one workspace's
// execution lease (managed_session_executions) and Session record
// (managed_sessions), from the tenant's SqlClient (CF: tenant D1; Node: its SQL).

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
