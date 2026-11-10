import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { createCfWorkRunnerAuthority } from "../../main/src/lib/cf-work-runner-authority";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });
async function fixture() {
  const sql = new CfD1SqlClient(env.MAIN_DB); const suffix = crypto.randomUUID();
  const sessionId = "session_" + suffix, environmentId = "env_" + suffix, workId = "work_" + suffix;
  await seedSandboxGatewaySessionRows(sql, "default", { id: sessionId, environmentId, vaultIds: [], agent: { id: "business-agent", version: 9 }, archivedAt: null });
  const document = { id: sessionId, environmentId, agent: { id: "business-agent", version: 9, openma: { harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } } } } };
  await sql.prepare("UPDATE managed_sessions SET document = ? WHERE workspace_id = ? AND id = ?").bind(JSON.stringify(document), "default", sessionId).run();
  await sql.prepare("INSERT OR REPLACE INTO managed_environments (workspace_id,id,document,revision,created_at,updated_at,archived_at) VALUES ('default',?,?,1,?,?,NULL)").bind(environmentId, JSON.stringify({ id: environmentId, config: { type: "cloud" } }), Date.now(), Date.now()).run();
  const work = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: plaintext }), open: async ({ ciphertext }) => ({ plaintext: ciphertext }) });
  const now = new Date().toISOString(); const token = "sk-ant-req-v1." + suffix;
  await work.insert({ workspaceId: "default", record: { work: { id: workId, environmentId, data: { id: sessionId, type: "session" }, acknowledgedAt: null, createdAt: now, latestHeartbeatAt: null, metadata: {}, startedAt: null, state: "queued", stopRequestedAt: null, stoppedAt: null }, secret: { sessionsToken: token }, claim: { generation: 1, claimedAt: now, workerId: "worker" }, heartbeatTtlSeconds: 90 } });
  const delivery = { workspaceId: "default", environmentId, sessionId, workId, apiBaseUrl: "https://control.test", workSecret: btoa(JSON.stringify({ sessions_token: token, api_base_url: "https://control.test", claim_generation: 1 })) };
  const authorize = createCfWorkRunnerAuthority({ sql, work, controlPlaneOrigin: "https://control.test" });
  return { sql, work, delivery, authorize };
}
it("reads pinned registry from real tenant D1 and permits reserved Work before runner ACK", async () => {
  const f = await fixture(); const result = await f.authorize(f.delivery);
  expect(result?.generation).toBe(1); expect(result?.harness).toEqual({ id: "claude-acp", version: "0.94.0" });
  expect(result?.session.agent.id).toBe("business-agent");
});
it("stopped claim refuses using the same row without fallback to supplied selection", async () => {
  const f = await fixture(); await f.sql.prepare("UPDATE managed_environment_work SET state='stopped' WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).run();
  expect(await f.authorize({ ...f.delivery, selection: { harnessPlacement: "in_sandbox" } } as never)).toBeNull();
});
it("wrong Work secret and missing workspace fail closed", async () => {
  const f = await fixture(); expect(await f.authorize({ ...f.delivery, workSecret: btoa(JSON.stringify({ sessions_token: "sk-ant-req-v1.other", api_base_url: "https://control.test" })) })).toBeNull();
  expect(await f.authorize({ ...f.delivery, workspaceId: "" })).toBeNull();
});
it("does not guess registry release from Agent id/version when its pin is absent", async () => {
  const f = await fixture(); await f.sql.prepare("UPDATE managed_sessions SET document=? WHERE workspace_id='default' AND id=?").bind(JSON.stringify({ id:f.delivery.sessionId, environmentId:f.delivery.environmentId, agent:{id:"business-agent",version:9,openma:{harness:"acp-sandbox"}} }),f.delivery.sessionId).run();
  expect(await f.authorize(f.delivery)).toBeNull();
});

it("composes real D1 authority and token store through the real CF bootstrap wrapper", async () => {
  const f = await fixture();
  const { createCfSqlWorkRunnerDispatch } = await import("../../main/src/lib/cf-work-runner-authority");
  const { CloudflareSandbox, setCloudflareSandboxForTest } = await import("../src/runtime/sandbox");
  const { attemptSandboxTokens, issueSandboxToken, sandboxTokenSha256 } = await import("@open-managed-agents/sandbox-gateway");
  const { createSqlEnvironmentWorkSandboxTokenStore, environmentWorkSandboxTokenRef } = await import("@open-managed-agents/sandbox-gateway-sql");
  const calls: unknown[][] = []; let signs = 0;
  setCloudflareSandboxForTest({ async setOutboundHandler(_name: string, context: unknown) { calls.push(["egress", context]); }, async setOutboundByHost() {}, async restrictOutboundToHosts(hosts: string[]) { calls.push(["network", hosts]); }, async startProcess(command: string, options: unknown) { calls.push(["start", command, options]); return { id: "runner", pid: 10, async kill() {}, async getStatus() { return "running"; } }; } });
  try {
    const runtime = new CloudflareSandbox({ SANDBOX: {}, MAIN_MCP: {} } as never, f.delivery.sessionId);
    const dispatcher = await createCfSqlWorkRunnerDispatch({ sql: f.sql, work: f.work, controlPlaneOrigin: "https://control.test", command: "/opt/openma/bin/openma-acp-work-item", tokens: attemptSandboxTokens(), sandbox: async () => runtime });
    await dispatcher.dispatch({ ...f.delivery, signal: new AbortController().signal });
    const launched = calls.find(c => c[0] === "start")![2] as { env: Record<string, string>; environmentMode: string };
    const egress = calls.find(c => c[0] === "egress")![1] as { tokenSha256: string };
    expect(launched.environmentMode).toBe("replace");
    expect(launched.env.OPENMA_HARNESS_ID).toBe("claude-acp"); expect(launched.env.OPENMA_HARNESS_VERSION).toBe("0.94.0");
    expect(egress.tokenSha256).toBe(await sandboxTokenSha256(launched.env.OPENMA_SANDBOX_TOKEN));
    const row = await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).first<{sandbox_token_hashes:string}>();
    const hashes = JSON.parse(row!.sandbox_token_hashes); expect(hashes).toHaveLength(1); expect(hashes[0].s).toBe("all");
    // No host ACK: the dispatched runner owns its existing admission barrier.
    const work = await f.sql.prepare("SELECT state FROM managed_environment_work WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).first<{state:string}>(); expect(work?.state).toBe("queued");
  } finally { setCloudflareSandboxForTest(undefined); }
});
