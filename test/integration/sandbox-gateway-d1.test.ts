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
import { describe, expect, it } from "vitest";
import { authenticateSandboxBearer, issueExecutionSessionsToken } from "../../packages/sandbox-gateway/src/index";
import { sealedExecutionSessionsToken } from "../../packages/managed-agents-adapters-runtime/src/environment-work-session-token";
import { WebCryptoAesGcm } from "../../packages/integrations-adapters-cf/src/index";
import { cfAcpExecutionAuthority } from "../../apps/main/src/lib/cf-acp-execution-capability";

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

// ACP model / MCP channels on Cloudflare (design §0.6): a token minted by the
// shared issuer opens through authMiddleware's execution authority on the
// proxy routes only, and only while its attempt is current.
describe("Cloudflare ACP execution sessions_token", () => {
  it("opens on the proxy routes while the attempt runs, never after it settles", async () => {
    const sql = sqlClientFromD1(env.MAIN_DB);
    const workspaceId = `ws_acp_${runId}`;
    const sessionId = `${workspaceId}_session`;
    const environmentId = `env_${sessionId}`;
    await seedSandboxGatewaySessionRows(sql, workspaceId, { id: sessionId, environmentId, vaultIds: [], agent: { id: "agent_01", version: 3 }, archivedAt: null });
    const executions = new SqlSessionExecutionStore(sql);
    const now = new Date().toISOString();
    await executions.admit({ execution: { id: `exe_${runId}`, workspaceId, sessionId, admittedAt: now, events: [{ id: `evt_${runId}`, type: "user.message", content: [], processedAt: now }] } });
    const claimed = await executions.claim({ workspaceId, sessionId, ownerId: "owner", attemptId: "attempt", claimedAt: now, leaseTtlMs: 60_000 });
    if (claimed.type !== "claimed") throw new Error("expected a claim");
    const secret = "test-platform-root-secret-0123456789";
    const authority = cfAcpExecutionAuthority(env, secret);
    const session = { id: sessionId, agent: { id: "agent_01", version: 3, skills: [] }, resources: [] };
    const token = await issueExecutionSessionsToken(authority.stores, claimed.fence,
      { workspaceId, sessionId, environmentId, agent: { id: "agent_01", version: 3 } },
      sealedExecutionSessionsToken(new WebCryptoAesGcm(secret, "managed.cf-acp.execution-token"), () => new Date(), { workspaceId, session, environmentId }));
    const open = (path: string) => authenticateSandboxBearer({ execution: authority, work: null }, { token, method: "POST", path });
    await expect(open(`/v1/oma/inference-proxy/${sessionId}/v1/messages`)).resolves.toMatchObject({ workspaceId, sessionId, workId: `exe_${runId}` });
    await expect(open(`/v1/oma/mcp-proxy/${sessionId}/server`)).resolves.toMatchObject({ sessionId });
    await expect(open(`/v1/sessions/${sessionId}`)).resolves.toBeNull();
    // Node's sealing purpose does not open here.
    const nodeSealed = await issueExecutionSessionsToken(authority.stores, claimed.fence,
      { workspaceId, sessionId, environmentId, agent: { id: "agent_01", version: 3 } },
      sealedExecutionSessionsToken(new WebCryptoAesGcm(secret, "managed.node-acp.execution-token"), () => new Date(), { workspaceId, session, environmentId }));
    await expect(authenticateSandboxBearer({ execution: authority, work: null }, { token: nodeSealed, method: "POST", path: `/v1/oma/mcp-proxy/${sessionId}/server` })).resolves.toBeNull();
    await executions.settle({ fence: claimed.fence, settledAt: new Date().toISOString(), outcome: "completed" });
    await expect(open(`/v1/oma/inference-proxy/${sessionId}/v1/messages`)).resolves.toBeNull();
  });
});
