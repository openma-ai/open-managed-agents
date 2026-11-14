import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, afterEach, expect, it } from "vitest";
import { cfWorkFinalizationRoutes } from "../../main/src/lib/cf-work-finalization";
import { SessionDO } from "../src/runtime/session-do";
import { setCloudflareSandboxForTest } from "../src/runtime/sandbox";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";

function nativePort(sessionId: string, environmentId: string, workId: string) {
  const locator = { workspaceId: "default", environmentId, sessionId, workId, generation: 2, holder: "owner", holderHash: "a".repeat(64), id: "process", epoch: "incarnation", pid: 41, startTicks: "123", status: "running", mounts: [{ mountPath: "/mnt/session/outputs", keyPrefix: `t/default/session-outputs/${sessionId}`, access: "read-write" }] };
  const files = new Map<string, string>([["/mnt/session/outputs/result.txt", "persisted output"]]);
  return {
    locator, files, snapshots: 0, fail: false, onSnapshot: undefined as undefined | (() => Promise<void>),
    async inspectWorkProcess() { return structuredClone(locator); },
    async workProcessIO(expected: unknown, op: { type: string; command?: string; path?: string; content?: string }) {
      if (JSON.stringify(expected) !== JSON.stringify(locator) || locator.status !== "running") throw Error("process lost");
      if (op.type === "read") return files.get(op.path!) ?? (() => { throw Error("missing"); })();
      if (op.type === "readBytes") return new TextEncoder().encode(files.get(op.path!) ?? "");
      if (op.type === "write") { files.set(op.path!, op.content!); return; }
      if (op.type === "run") {
        let stdout = "";
        if (op.command!.includes("find") && op.command!.includes("/mnt/session/outputs")) stdout = btoa("./result.txt\0");
        return { exitCode: 0, stdout, stderr: "" };
      }
      throw Error("unknown operation");
    },
    async createContainerSnapshot(_options?: unknown) {
      await this.onSnapshot?.();
      if (this.fail) throw Error("snapshot failed");
      return { id: `container-${sessionId}-${++this.snapshots}` };
    },
  };
}

beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });
afterEach(() => setCloudflareSandboxForTest(undefined));

async function fixture() {
  const sql = new CfD1SqlClient(env.MAIN_DB!);
  const sessionId = `sess_${crypto.randomUUID()}`, environmentId = `env_${crypto.randomUUID()}`, workId = `work_${crypto.randomUUID()}`;
  const now = new Date(), root = "test-platform-root-secret-padded-to-thirtytwo";
  await seedSandboxGatewaySessionRows(sql, "default", { id: sessionId, environmentId, vaultIds: [], agent: { id: "agent", version: 1 }, archivedAt: null });
  const session = { id: sessionId, agent: { id: "agent", version: 1, name: "Agent" }, environmentId, status: "running", createdAt: now.toISOString(), updatedAt: now.toISOString(), archivedAt: null, budget: null, usage: {}, outcomeEvaluations: [], resources: [], metadata: {} };
  await sql.prepare("UPDATE managed_sessions SET document=?,revision=3,status='running' WHERE workspace_id='default' AND id=?").bind(JSON.stringify(session), sessionId).run();
  const cipher = new WebCryptoAesGcm(root, "managed.environment-work.secret"), codec = new WebCryptoAesGcm(root, "managed.environment-work.session-token");
  const token = "sk-ant-req-v1." + await codec.encrypt(JSON.stringify({ version: 1, workspaceId: "default", sessionId, environmentId, workId, generation: 2, claimedAt: now.toISOString(), issuedAt: now.toISOString(), expiresAt: new Date(+now + 3600000).toISOString(), skills: [], files: [], memoryStores: [] }));
  const work = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }), open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }) });
  await work.insert({ workspaceId: "default", record: { work: { id: workId, environmentId, data: { type: "session", id: sessionId }, state: "active", createdAt: now.toISOString(), metadata: {}, acknowledgedAt: now.toISOString(), latestHeartbeatAt: now.toISOString(), startedAt: now.toISOString(), stopRequestedAt: null, stoppedAt: null }, secret: { sessionsToken: token }, claim: { generation: 2, claimedAt: now.toISOString(), workerId: "owner" }, heartbeatTtlSeconds: 90 } });
  await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes=? WHERE id=?").bind(JSON.stringify([{ h: "a".repeat(64), s: "all" }]), workId).run();
  await sql.prepare("INSERT INTO managed_session_events(workspace_id,session_id,thread_id,id,type,document,processed_at) VALUES ('default',?,NULL,'input','user.message',?,?)").bind(sessionId, JSON.stringify({ id: "input", type: "user.message", content: [], processedAt: now.toISOString(), source_position: { revision: 2, index: 0, consumed_by_execution_id: "input" } }), +now).run();
  const stub = env.SESSION_DO!.get(env.SESSION_DO!.idFromName(JSON.stringify(["default", sessionId])));
  const configured = { ...env, PLATFORM_ROOT_SECRET: root, SANDBOX_ADAPTER: "cloudflare", PUBLIC_BASE_URL: "https://control.test" };
  const native = nativePort(sessionId, environmentId, workId);
  await env.FILES_BUCKET!.put(`t/default/session-outputs/${sessionId}/result.txt`, "persisted output");
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.kv.put("cloudflare_sandbox_state", { phase: "running", handle: { provider: "cloudflare", runtimeId: sessionId }, runStartedAt: Date.now(), latestSnapshot: { status: "none" }, stores: [], outputs: true, version: 0 });
  });
  setCloudflareSandboxForTest(native);
  const binding = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init), url = new URL(req.url), body = await req.text();
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const owner = new SessionDO(state, configured as never);
      const response = await owner.fetch(new Request("https://internal" + url.pathname.replace(`/sessions/${sessionId}`, ""), { method: req.method, headers: req.headers, body }));
      return { status: response.status, body: await response.text() };
    });
    return new Response(result.body, { status: result.status });
  } };
  const routes = cfWorkFinalizationRoutes({ ...configured, SANDBOX_sandbox_default: binding } as never);
  const send = (action: string, body: object) => routes.request(`/${sessionId}/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { sql, sessionId, workId, stub, configured, send, token, native, environmentId };
}

it("native sealed route flushes storage then publishes a complete container snapshot", async () => {
  const f = await fixture();
  f.native.onSnapshot = async () => {
    expect(await (await env.FILES_BUCKET!.get(`t/default/session-outputs/${f.sessionId}/result.txt`))?.text()).toBe("persisted output");
    expect((await f.sql.prepare("SELECT id FROM managed_session_events WHERE session_id=? AND type='session.status_idle'").bind(f.sessionId).all()).results).toEqual([]);
  };
  const response = await f.send("work-finalize", { turnId: "input", revision: 3, stopReason: { type: "end_turn" } });
  expect(response.status, await response.clone().text()).toBe(200);
  const state = await runInDurableObject(f.stub, async (_instance, objectState) => objectState.storage.kv.get("cloudflare_sandbox_state"));
  expect(state).toMatchObject({ phase: "running", latestSnapshot: { status: "taken", ref: { provider: "cloudflare", kind: "snapshot", metadata: { kind: "container" } } } });
  expect((await f.sql.prepare("SELECT COUNT(*) AS n FROM workspace_backups WHERE source_session_id=?").bind(f.sessionId).all()).results).toEqual([{ n: 0 }]);
});

it("native snapshot CAS loss refuses the terminal and leaves no archive", async () => {
  const f = await fixture();
  f.native.onSnapshot = async () => { await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='successor' WHERE id=?").bind(f.workId).run(); };
  const response = await f.send("work-finalize", { turnId: "input", revision: 3, stopReason: { type: "end_turn" } });
  expect(response.status).toBe(409);
  expect((await f.sql.prepare("SELECT COUNT(*) AS n FROM workspace_backups WHERE source_session_id=?").bind(f.sessionId).all()).results).toEqual([{ n: 0 }]);
});

it("native route rejects a forged Work holder before taking a snapshot", async () => {
  const f = await fixture();
  f.native.locator.holder = "other";
  expect((await f.send("work-checkpoint", { turnId: "input", revision: 3 })).status).not.toBe(200);
  expect(f.native.snapshots).toBe(0);
});
