// The sandbox token store gateways verify against (design §0.0b B.1, B.3):
// one token type, two lanes that issue it. A Session's sandbox token belongs
// either to its running execution attempt (managed lane,
// managed_session_executions) or to the held Environment Work claim
// (self-hosted lane, managed_environment_work, ADR 0005). Verification only
// knows the Session id and the token, so `find` asks both and takes the lane
// holding the hash. A hash held by both is a broken invariant and throws
// (the authority answers `unavailable`, 503), never a silent pick.
// Issuing is lane-specific: the execution attempt issues here, a Work claim
// through createSqlEnvironmentWorkSandboxTokenStore.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SandboxTokenStore } from "@open-managed-agents/sandbox-gateway";
import { createSqlEnvironmentWorkSandboxTokenStore } from "./environment-work-sandbox-token-store-sql";
import { createSqlSandboxTokenStore } from "./sandbox-token-store-sql";

export function createSqlGatewaySandboxTokenStore(sql: SqlClient): SandboxTokenStore {
  const executions = createSqlSandboxTokenStore(sql);
  const work = createSqlEnvironmentWorkSandboxTokenStore(sql);
  return {
    async find(input) {
      const [execution, claim] = await Promise.all([executions.find(input), work.find(input)]);
      if (execution?.attempt && claim?.attempt) {
        throw new Error(`Sandbox token of Session ${input.sessionId} is held by both an execution attempt and an Environment Work claim`);
      }
      if (claim?.attempt) return claim;
      return execution ?? claim;
    },
    findSession: (input) => executions.findSession(input),
    replaceTokenHash: (input) => executions.replaceTokenHash(input),
  };
}
