// @ts-nocheck
// Cloudflare adapters of the Session execution Ports on the tenant D1 they
// run on in production (apps/main cfSandboxGatewayStores): the shared
// conformance suites (design §0.7 测试门禁 2). Node runs the same suites in
// packages/session-runtime-sql/test/execution-lease.test.ts and
// apps/main-node/test/node-managed-acp-capability.test.ts.
import { env, exports } from "cloudflare:workers";
import { beforeAll } from "vitest";
import { sqlClientFromD1 } from "../../packages/sql-client/src/adapters/cf-d1";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionStore } from "../../packages/session-runtime-sql/src/coordination";
import { createSqlSessionExecutionLeases } from "../../packages/session-runtime-sql/src/execution-lease";
import { createSqlSandboxGatewayStore } from "../../packages/sandbox-gateway-sql/src/index";
import { sessionExecutionLeasesConformance } from "../../packages/session-runtime/test/execution-lease-conformance";
import { sandboxGatewayStoreConformance, seedSandboxGatewaySessionRows } from "../../packages/sandbox-gateway/test/gateway-store-conformance";

// D1 is shared by the whole file: every fixture gets its own workspace.
const runId = crypto.randomUUID();
beforeAll(async () => {
  await exports.default.fetch(new Request("http://localhost/health"));
  await ensureSessionExecutionCoordinatorSchema(sqlClientFromD1(env.MAIN_DB));
});

sessionExecutionLeasesConformance("SQL row reader (CF tenant D1)", {
  async withLeases(fixtureId, run) {
    const sql = sqlClientFromD1(env.MAIN_DB);
    return run({
      workspaceId: `ws_lease_${fixtureId}_${runId}`,
      executions: new SqlSessionExecutionStore(sql),
      leases: createSqlSessionExecutionLeases(sql),
    });
  },
});

sandboxGatewayStoreConformance("sandbox-gateway-sql (CF tenant D1)", {
  async withStore(fixtureId, run) {
    const sql = sqlClientFromD1(env.MAIN_DB);
    const workspaceId = `ws_gateway_${fixtureId}_${runId}`;
    return run({
      workspaceId,
      executions: new SqlSessionExecutionStore(sql),
      store: createSqlSandboxGatewayStore(sql),
      seedSession: (session) => seedSandboxGatewaySessionRows(sql, workspaceId, session),
    });
  },
});
