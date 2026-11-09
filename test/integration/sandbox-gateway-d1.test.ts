// @ts-nocheck
// Cloudflare adapters of the Session execution Ports on the tenant D1 they
// run on in production (apps/main cfSandboxTokenStore): the shared
// conformance suites (design §0.7 测试门禁 2). Node runs the same suites in
// packages/session-runtime-sql/test/execution-lease.test.ts and
// apps/main-node/test/node-managed-acp-capability.test.ts.
import { env, exports } from "cloudflare:workers";
import { beforeAll } from "vitest";
import { sqlClientFromD1 } from "../../packages/sql-client/src/adapters/cf-d1";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionStore } from "../../packages/session-runtime-sql/src/coordination";
import { createSqlSessionExecutionLeases } from "../../packages/session-runtime-sql/src/execution-lease";
import { sessionExecutionLeasesConformance } from "../../packages/session-runtime/test/execution-lease-conformance";
import { seedSandboxGatewaySessionRows } from "../../packages/sandbox-gateway/test/gateway-store-conformance";
import { describe, expect, it } from "vitest";
import { attemptSandboxTokens, authenticateSandboxToken } from "../../packages/sandbox-gateway/src/index";
import { createSqlSandboxTokenStore } from "../../packages/sandbox-gateway-sql/src/index";
import { gatedSql, sandboxTokenStoreConformance, type SandboxTokenStoreTestHarness } from "../../packages/sandbox-gateway/test/sandbox-token-store-conformance";
import { sandboxTokenRaceConformance } from "../../packages/sandbox-gateway/test/sandbox-token-race-conformance";
import { cfAcpExecutionChannels } from "../../apps/main/src/lib/cf-acp-execution-capability";
import { cfSandboxTokenStore, cfTenantDatabases } from "../../apps/main/src/lib/cf-sandbox-token-store";

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

const d1TokenHarness: SandboxTokenStoreTestHarness = {
  async withStore(fixtureId, run) {
    const raw = sqlClientFromD1(env.MAIN_DB);
    const { sql, gate } = gatedSql(raw);
    const workspaceId = `ws_token_${fixtureId}_${runId}`.replace(/[^A-Za-z0-9_]/gu, "_");
    return run({
      workspaceId, gate, raw,
      store: createSqlSandboxTokenStore(sql),
      executions: new SqlSessionExecutionStore(raw),
      seedSession: (session) => seedSandboxGatewaySessionRows(raw, workspaceId, session),
      setTokenColumn: async (executionId, value) => {
        await raw.prepare("UPDATE managed_session_executions SET sandbox_token_hashes = ? WHERE workspace_id = ? AND id = ?").bind(value, workspaceId, executionId).run();
      },
      archive: async (sessionId, atMs) => {
        await raw.prepare("UPDATE managed_sessions SET archived_at = ? WHERE workspace_id = ? AND id = ?").bind(atMs, workspaceId, sessionId).run();
      },
    });
  },
};
sandboxTokenStoreConformance("sandbox-gateway-sql (CF tenant D1, workerd)", d1TokenHarness);
sandboxTokenRaceConformance("sandbox-gateway-sql (CF tenant D1, workerd)", d1TokenHarness);

async function claimedSession(name: string) {
  const sql = sqlClientFromD1(env.MAIN_DB);
  const workspaceId = `ws_${name}_${runId}`;
  const sessionId = `${workspaceId}_session`;
  const environmentId = `env_${sessionId}`;
  await seedSandboxGatewaySessionRows(sql, workspaceId, { id: sessionId, environmentId, vaultIds: [], agent: { id: "agent_01", version: 3 }, archivedAt: null });
  const executions = new SqlSessionExecutionStore(sql);
  const now = new Date().toISOString();
  await executions.admit({ execution: { id: `exe_${name}_${runId}`, workspaceId, sessionId, admittedAt: now, events: [{ id: `evt_${name}_${runId}`, type: "user.message", content: [], processedAt: now }] } });
  const claimed = await executions.claim({ workspaceId, sessionId, ownerId: "owner", attemptId: "attempt", claimedAt: now, leaseTtlMs: 60_000 });
  if (claimed.type !== "claimed") throw new Error("expected a claim");
  return { sql, workspaceId, sessionId, environmentId, executions, fence: claimed.fence };
}

// The Cloudflare token store finds the Session by id across tenant D1s
// (here: single-D1, MAIN_DB only), and the RPC-issued forwarder token takes
// its scope from the harness name.
describe("Cloudflare sandbox token store", () => {
  it("routes find over every tenant D1 and issue to the workspace's; scope follows the harness", async () => {
    expect(cfTenantDatabases(env).length).toBeGreaterThanOrEqual(1);
    const s = await claimedSession("cfstore");
    const store = cfSandboxTokenStore(env);
    const { issueSandboxToken, sandboxHarnessPlacement, sandboxTokenScopeFor } = await import("../../packages/sandbox-gateway/src/index");
    const egressToken = await issueSandboxToken(store, s.fence, { scope: sandboxTokenScopeFor(sandboxHarnessPlacement("default")) });
    expect((await authenticateSandboxToken(store, { sessionId: s.sessionId, token: egressToken, channel: "egress" })).type).toBe("accepted");
    expect((await authenticateSandboxToken(store, { sessionId: s.sessionId, token: egressToken, channel: "api" })).type).toBe("rejected");
  });
});

// The CF path hands acp-sandbox-loop the card's upstream model id
// (hostedInference.model.wireModel), not the handle: pi silently falls back
// to its default model on an id it does not know (same as Node, 3b698424).
describe("Cloudflare ACP execution channels", () => {
  let card: Promise<Response> | undefined;
  /** An acp-sandbox Session with a model card and a claimed attempt. */
  async function acpAttempt(tag: string) {
    card ??= exports.default.fetch(new Request("http://localhost/v1/oma/model_cards", {
      method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model_id: `acp-handle-${runId}`, model: "claude-sonnet-5-5", api_key: "sk-ant-test-key" }),
    }));
    expect([201, 409]).toContain((await card).status);
    const sql = sqlClientFromD1(env.MAIN_DB);
    const workspaceId = "default";
    const sessionId = `acp_${tag}_${runId}`;
    const environmentId = `env_${sessionId}`;
    await seedSandboxGatewaySessionRows(sql, workspaceId, { id: sessionId, environmentId, vaultIds: [], agent: { id: "agent_01", version: 3 }, archivedAt: null });
    const document = { id: sessionId, environmentId, vaultIds: [], resources: [], agent: { id: "agent_01", version: 3, name: "agent", model: `acp-handle-${runId}`, skills: [] } };
    await sql.prepare("UPDATE managed_sessions SET document = ? WHERE workspace_id = ? AND id = ?").bind(JSON.stringify(document), workspaceId, sessionId).run();
    const executions = new SqlSessionExecutionStore(sql);
    const now = new Date().toISOString();
    await executions.admit({ execution: { id: `exe_${tag}_${runId}`, workspaceId, sessionId, admittedAt: now, events: [{ id: `evt_${tag}_${runId}`, type: "user.message", content: [], processedAt: now }] } });
    const claimed = await executions.claim({ workspaceId, sessionId, ownerId: "owner", attemptId: "attempt", claimedAt: now, leaseTtlMs: 60_000 });
    if (claimed.type !== "claimed") throw new Error("expected a claim");
    const hashes = async () => JSON.parse((await sql.prepare("SELECT sandbox_token_hashes FROM managed_session_executions WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, claimed.fence.executionId).first<{ sandbox_token_hashes: string }>())!.sandbox_token_hashes) as unknown[];
    return { workspaceId, sessionId, fence: claimed.fence, hashes, env: { ...env, PLATFORM_ROOT_SECRET: "test-platform-root-secret-0123456789", PUBLIC_BASE_URL: "https://oma.example/" } };
  }

  /** The main worker RPC SessionDO asks (MAIN_MCP.issueSandboxToken). */
  const issue = (a: Awaited<ReturnType<typeof acpAttempt>>) => () =>
    env.MAIN_MCP.issueSandboxToken({ tenantId: a.workspaceId, sessionId: a.sessionId, attempt: a.fence, harness: "acp-sandbox" });

  it("carry the model card's upstream wireModel", async () => {
    const a = await acpAttempt("ch");
    const channels = await cfAcpExecutionChannels(a.env, { tenantId: a.workspaceId, sessionId: a.sessionId, sessionsToken: await issue(a)() });
    expect(channels.hostedInference.model).toMatchObject({ providerId: "anthropic", wireModel: "claude-sonnet-5-5" });
    expect(channels.hostedInference.gatewayBaseUrl).toBe("https://oma.example");
    expect(channels.mcpProxy.sessionsToken).toBe(channels.hostedInference.sessionsToken);
    // The in-sandbox ACP harness gets the one sandbox token, scope all.
    expect(channels.mcpProxy.sessionsToken).toMatch(/^oma_sbx_[0-9A-Za-z]{49}$/u);
    expect((await authenticateSandboxToken(cfSandboxTokenStore(env), { sessionId: a.sessionId, token: channels.mcpProxy.sessionsToken, channel: "api" })).type).toBe("accepted");
  });

  // One execution, one token (design §0.0 rule 10), as SessionDO composes
  // it: the E2B egress relay and the ACP harness channels of one attempt.
  it("acp-sandbox: the relay and the harness channels of one attempt share one token, one hash", async () => {
    const a = await acpAttempt("one");
    const tokens = attemptSandboxTokens();
    const relay = await tokens.relayDelivery(a.fence, issue(a));
    const channels = await cfAcpExecutionChannels(a.env, { tenantId: a.workspaceId, sessionId: a.sessionId, sessionsToken: await tokens.token(a.fence, issue(a)) });
    expect(await a.hashes()).toHaveLength(1);
    expect(channels.hostedInference.sessionsToken).toBe(relay);
  });

  it("a relay re-delivery in the same attempt re-signs: appended, the earlier token stays valid", async () => {
    const a = await acpAttempt("redeliver");
    const tokens = attemptSandboxTokens();
    const shared = await tokens.token(a.fence, issue(a));
    expect(await tokens.relayDelivery(a.fence, issue(a))).toBe(shared);
    const redelivered = await tokens.relayDelivery(a.fence, issue(a));
    expect(redelivered).not.toBe(shared);
    expect(await a.hashes()).toHaveLength(2);
    for (const token of [shared, redelivered]) {
      expect((await authenticateSandboxToken(cfSandboxTokenStore(env), { sessionId: a.sessionId, token, channel: "api" })).type).toBe("accepted");
    }
  });

  it("refuse a token that does not open the Session's API channels", async () => {
    const a = await acpAttempt("refuse");
    await expect(cfAcpExecutionChannels(a.env, { tenantId: a.workspaceId, sessionId: a.sessionId, sessionsToken: "oma_sbx_not-a-token" })).rejects.toThrow(/current sandbox token/);
  });
});
