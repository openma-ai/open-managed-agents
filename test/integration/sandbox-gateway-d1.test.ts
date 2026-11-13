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
import { createSandboxPorts } from "../../packages/sandbox-port-kit/src/create-sandbox-ports";
import { createE2BV2Adapter } from "../../packages/sandbox-adapter-e2b/src/v2";
import { E2BSandboxExecutor } from "../../packages/sandbox-adapter-e2b/src/e2b";
import { sandboxTokenAuthDecision } from "../../packages/sandbox-gateway/src/index";
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

  it("no Vault on CF to E2B: a new physical sandbox revokes MCP and inference; reattach reuses", async () => {
    const a = await acpAttempt("no_vault");
    const tokens = attemptSandboxTokens();
    let issued = 0;
    const issueToken = async () => { issued++; return issue(a)(); };
    const runtime = (sandboxId: string) => new E2BSandboxExecutor({
      sandboxId, commands: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      files: { read: async () => "", write: async () => {} }, kill: async () => {}, updateNetwork: async () => {},
    }, {});
    const adapter = createE2BV2Adapter({ sdk: {} as never, connection: { apiKey: "unused" }, leaseMs: 1_800_000, maxLifetimeMs: 3_600_000 });
    const { ports: { egress } } = createSandboxPorts(adapter, { storage: {} as never, egress: { gateway: {
      endpoint: { url: "https://oma.example" },
      issueToken: ({ attempt, sandbox }) => tokens.relayDelivery(attempt!, issueToken, sandbox),
      authenticate: async () => null, handle: async () => new Response(null, { status: 403 }),
    } } });
    const scope = { workspaceId: a.workspaceId, sessionId: a.sessionId, environmentId: "env", workId: a.fence.executionId };
    const attach = (box: E2BSandboxExecutor) => egress.attach({ runtime: box, scope, fence: { ...scope, ownerId: a.fence.ownerId, generation: a.fence.generation, token: a.fence.attemptId, expiresAt: new Date(Date.now() + 60_000).toISOString() }, policy: null, signal: new AbortController().signal });
    const old = await tokens.token(a.fence, issueToken);
    await attach(runtime("box-1"));
    await attach(runtime("box-1"));
    expect(await tokens.token(a.fence, issueToken)).toBe(old);
    expect(issued).toBe(1);
    await attach(runtime("box-2"));
    const fresh = await tokens.token(a.fence, issueToken);
    expect(issued).toBe(2);
    expect(fresh).not.toBe(old);
    expect(await a.hashes()).toHaveLength(1);
    for (const path of ["/v1/oma/mcp-proxy/" + a.sessionId + "/missing", "/v1/oma/inference-proxy/" + a.sessionId + "/anthropic/v1/messages"]) {
      const request = (token: string) => ({ headers: new Headers({ authorization: "Bearer " + token }), method: "POST", path });
      expect((await sandboxTokenAuthDecision(cfSandboxTokenStore(env), request(old))).type).toBe("rejected");
      expect((await exports.default.fetch(new Request("http://localhost" + path, { method: "POST", headers: { authorization: "Bearer " + old }, body: "{}" }))).status).toBe(401);
      expect((await sandboxTokenAuthDecision(cfSandboxTokenStore(env), request(fresh))).type).toBe("accepted");
    }
  });

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

  it("a replacement sandbox in the same attempt rotates the sole hash and immediately revokes the earlier token", async () => {
    const a = await acpAttempt("redeliver");
    const tokens = attemptSandboxTokens();
    const shared = await tokens.token(a.fence, issue(a));
    expect(await tokens.relayDelivery(a.fence, issue(a), "box-1")).toBe(shared);
    const redelivered = await tokens.relayDelivery(a.fence, issue(a), "box-2");
    expect(redelivered).not.toBe(shared);
    expect(await a.hashes()).toHaveLength(1);
    expect((await authenticateSandboxToken(cfSandboxTokenStore(env), { sessionId: a.sessionId, token: shared, channel: "api" })).type).toBe("rejected");
    expect((await authenticateSandboxToken(cfSandboxTokenStore(env), { sessionId: a.sessionId, token: redelivered, channel: "api" })).type).toBe("accepted");
  });

  it.each(["model", "provider"])("rejects an incomplete model card (%s) rather than starting without inference", async field => {
    const a = await acpAttempt("incomplete_" + field);
    const token = await issue(a)();
    const sql = sqlClientFromD1(env.MAIN_DB);
    const previous = await sql.prepare("SELECT model, provider FROM model_cards WHERE tenant_id = ? AND model_id = ?").bind("default", "acp-handle-" + runId).first();
    try {
      await sql.prepare("UPDATE model_cards SET " + field + " = '' WHERE tenant_id = ? AND model_id = ?").bind("default", "acp-handle-" + runId).run();
      await expect(cfAcpExecutionChannels(a.env, { tenantId: "default", sessionId: a.sessionId, sessionsToken: token })).rejects.toThrow(/active workspace model card/);
    } finally {
      await sql.prepare("UPDATE model_cards SET model = ?, provider = ? WHERE tenant_id = ? AND model_id = ?").bind(previous.model, previous.provider, "default", "acp-handle-" + runId).run();
    }
  });

  it("actual CF HTTP composition accepts only current all-scope Work channels without minting a token", async () => {
    const a = await acpAttempt("work_http");
    const { default: app } = await import("../../apps/main/src/index");
    const sql = sqlClientFromD1(env.MAIN_DB);
    const { createSqlEnvironmentWorkSandboxTokenStore, environmentWorkSandboxTokenRef } = await import("../../packages/sandbox-gateway-sql/src/index");
    const { issueSandboxToken } = await import("../../packages/sandbox-gateway/src/index");
    const workId = "work_http_" + runId, environmentId = "env_" + a.sessionId;
    await sql.prepare("INSERT INTO managed_environment_work (workspace_id, environment_id, id, session_id, document, sealed_secret, claim_at, claim_generation, heartbeat_ttl_seconds, revision, state, created_at) VALUES (?, ?, ?, ?, '{}', 'unused', ?, 1, 90, 1, 'active', ?)").bind("default", environmentId, workId, a.sessionId, Date.now(), Date.now()).run();
    const fence = environmentWorkSandboxTokenRef({ workspaceId: "default", environmentId, sessionId: a.sessionId, workId, generation: 1 });
    const store = createSqlEnvironmentWorkSandboxTokenStore(sql);
    const token = await issueSandboxToken(store, fence, { scope: "all" });
    const call = (bearer: string, sessionId = a.sessionId) => app.fetch(new Request("https://oma.example/v1/oma/sessions/" + sessionId + "/execution-channels", { method: "POST", headers: { authorization: "Bearer " + bearer, "content-type": "application/json" }, body: "{}" }), a.env);
    const hashes = async () => (await sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE workspace_id = 'default' AND id = ?").bind(workId).first()).sandbox_token_hashes;
    const before = await hashes();
    const response = await call(token);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ type: "ready", channels: { mcpProxy: { sessionsToken: token }, hostedInference: { sessionsToken: token, model: { wireModel: "claude-sonnet-5-5" } } } });
    expect(JSON.stringify(result)).not.toContain("sk-ant-test-key");
    expect(await hashes()).toBe(before);
    // Exercise expiry through the actual HTTP composition without stepping
    // the VM clock: the same token is valid only while its Work lease is live.
    await sql.prepare("UPDATE managed_environment_work SET claim_at = ? WHERE id = ?").bind(Date.now() - 90_001, workId).run();
    expect((await call(token)).status).toBe(401);
    expect(await hashes()).toBe(before);
    await sql.prepare("UPDATE managed_environment_work SET claim_at = ? WHERE id = ?").bind(Date.now(), workId).run();
    expect((await call(token)).status).toBe(200);
    expect((await call(token, "wrong-session")).status).toBe(401);
    expect((await call("test-key")).status).toBe(401);
    expect((await call("sk-ant-req-v1.work-bearer")).status).toBe(401);
    // A managed execution token is NOT a Work claim token even for this Session.
    const executionToken = await issueSandboxToken(cfSandboxTokenStore(env), a.fence, { scope: "all" });
    expect((await call(executionToken)).status).toBe(401);
    const entries = JSON.parse(before); entries[0].s = "egress";
    await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes = ? WHERE id = ?").bind(JSON.stringify(entries), workId).run();
    expect((await call(token)).status).toBe(401);
    await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes = ?, claim_generation = 2 WHERE id = ?").bind(null, workId).run();
    expect((await call(token)).status).toBe(401);
    const replacement = await issueSandboxToken(store, { ...fence, attemptId: "environment-work-claim:2", generation: 2 }, { scope: "all" });
    expect((await call(replacement)).status).toBe(200);
    expect((await call(token)).status).toBe(401);
    await sql.prepare("UPDATE managed_environment_work SET state = 'stopped' WHERE id = ?").bind(workId).run();
    expect((await call(replacement)).status).toBe(401);
  });

  it("Work claim holder supplies both channels with the same all-scope oma_sbx and is revoked on stop", async () => {
    const a = await acpAttempt("work_channels");
    const sql = sqlClientFromD1(env.MAIN_DB);
    const { createSqlEnvironmentWorkSandboxTokenStore, environmentWorkSandboxTokenRef } = await import("../../packages/sandbox-gateway-sql/src/index");
    const { issueSandboxToken } = await import("../../packages/sandbox-gateway/src/index");
    const workId = "work_channels_" + runId, environmentId = "env_" + a.sessionId;
    await sql.prepare("INSERT INTO managed_environment_work (workspace_id, environment_id, id, session_id, document, sealed_secret, claim_at, claim_generation, heartbeat_ttl_seconds, revision, state, created_at) VALUES (?, ?, ?, ?, '{}', 'unused', ?, 1, 90, 1, 'active', ?)").bind("default", environmentId, workId, a.sessionId, Date.now(), Date.now()).run();
    const token = await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql), environmentWorkSandboxTokenRef({ workspaceId: "default", environmentId, sessionId: a.sessionId, workId, generation: 1 }), { scope: "all" });
    const channels = await cfAcpExecutionChannels(a.env, { tenantId: "default", sessionId: a.sessionId, sessionsToken: token });
    expect(channels.mcpProxy.sessionsToken).toBe(token);
    expect(channels.hostedInference.sessionsToken).toBe(token);
    expect(channels.hostedInference.model).toMatchObject({ providerId: "anthropic", wireModel: "claude-sonnet-5-5" });
    await sql.prepare("UPDATE managed_environment_work SET state = 'stopped' WHERE workspace_id = ? AND id = ?").bind("default", workId).run();
    await expect(cfAcpExecutionChannels(a.env, { tenantId: "default", sessionId: a.sessionId, sessionsToken: token })).rejects.toThrow(/current sandbox token/);
  });

  it("refuse a token that does not open the Session's API channels", async () => {
    const a = await acpAttempt("refuse");
    await expect(cfAcpExecutionChannels(a.env, { tenantId: a.workspaceId, sessionId: a.sessionId, sessionsToken: (await import("../../packages/sandbox-gateway/src/index")).generateSandboxToken() })).rejects.toThrow(/current sandbox token/);
  });
});


it("actual CF HTTP commits Work startup failure and allows only exact stopped replay", async () => {
  const { default: app } = await import("../../apps/main/src/index");
  const { WebCryptoAesGcm } = await import("../../packages/integrations-adapters-cf/src/index");
  const root = "startup-fixture-root-secret-0123456789";
  const testEnv = {...env,PLATFORM_ROOT_SECRET:root};
  const sql = sqlClientFromD1(env.MAIN_DB);
  const sessionId = "startup_" + runId, workId = "startup_work_" + runId;
  const now = new Date().toISOString();
  await seedSandboxGatewaySessionRows(sql,"default",{id:sessionId,environmentId:"env",vaultIds:[],agent:{id:"agent",version:1},archivedAt:null});
  const doc = {id:sessionId,agent:{id:"agent",version:1},environmentId:"env",status:"running",updatedAt:now,archivedAt:null};
  await sql.prepare("UPDATE managed_sessions SET document = ?,status = 'running',revision = 3 WHERE workspace_id = 'default' AND id = ?").bind(JSON.stringify(doc),sessionId).run();
  const tokenCipher = new WebCryptoAesGcm(root,"managed.environment-work.session-token");
  const token = "sk-ant-req-v1." + await tokenCipher.encrypt(JSON.stringify({version:1,workspaceId:"default",environmentId:"env",sessionId,workId,issuedAt:now,expiresAt:new Date(Date.now()+60000).toISOString(),claimedAt:now,generation:1,skills:[],files:[],memoryStores:[]}));
  const secret = await new WebCryptoAesGcm(root,"managed.environment-work.secret").encrypt(JSON.stringify({sessionsToken:token}));
  await sql.prepare("INSERT INTO managed_environment_work (workspace_id,environment_id,id,session_id,document,sealed_secret,claim_at,claim_generation,heartbeat_ttl_seconds,revision,state,created_at) VALUES ('default','env',?,?,?,?,?,1,90,4,'active',?)").bind(workId,sessionId,JSON.stringify({id:workId,environmentId:'env',data:{type:'session',id:sessionId},state:'active'}),secret,Date.now(),Date.now()).run();
  const send = (action,body,bearer=token) => app.fetch(new Request("https://oma.example/v1/oma/sessions/"+sessionId+"/"+action,{method:"POST",headers:{authorization:"Bearer "+bearer,"content-type":"application/json"},body:JSON.stringify(body)}),testEnv);
  expect((await send("startup-boundary",{})).status).toBe(200);
  expect((await send("runtime-events",{events:[{id:"own-running",type:"session.status_running",processed_at:now}]})).status).toBe(200);
  expect((await send("startup-failed",{revision:3,processedAt:now},"admin")).status).toBe(401);
  expect((await send("startup-failed",{revision:3,processedAt:now})).status).toBe(200);
  expect((await send("startup-failed",{revision:3,processedAt:now})).status).toBe(200);
  expect((await send("startup-failed",{revision:4,processedAt:now})).status).toBe(409);
  expect((await send("startup-boundary",{})).status).toBe(409);
  expect(await sql.prepare("SELECT state FROM managed_environment_work WHERE id = ?").bind(workId).first()).toEqual({state:"stopped"});
  expect(await sql.prepare("SELECT status,revision FROM managed_sessions WHERE id = ?").bind(sessionId).first()).toEqual({status:"idle",revision:5});
  const read = await app.fetch(new Request("https://oma.example/v1/sessions/"+sessionId,{headers:{authorization:"Bearer "+token}}),testEnv);
  expect(read.status).toBe(401);
});
