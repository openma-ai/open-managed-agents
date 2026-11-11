import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { handleWorkPhysicalObservation } from "../src/runtime/work-physical-observation";
import { SessionDO } from "../src/runtime/session-do";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";

beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });
async function fixture() {
  const sql = new CfD1SqlClient(env.MAIN_DB!);
  const sessionId = "sess_" + crypto.randomUUID(), environmentId = "env_" + crypto.randomUUID(), workId = "work_" + crypto.randomUUID();
  await seedSandboxGatewaySessionRows(sql, "default", { id: sessionId, environmentId, vaultIds: [], agent: { id: "agent", version: 1 }, archivedAt: null });
  const work = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: plaintext }), open: async ({ ciphertext }) => ({ plaintext: ciphertext }) });
  const now = new Date().toISOString();
  await work.insert({ workspaceId: "default", record: { work: { id: workId, environmentId, data: { type: "session", id: sessionId }, state: "active", createdAt: now, metadata: {}, acknowledgedAt: now, latestHeartbeatAt: now, startedAt: now, stopRequestedAt: null, stoppedAt: null }, secret: { sessionsToken: "private-token" }, claim: { generation: 2, claimedAt: now, workerId: "worker" }, heartbeatTtlSeconds: 90 } });
  const stub = env.SESSION_DO!.get(env.SESSION_DO!.idFromName(JSON.stringify(["default", sessionId])));
  const record = { phase: "running", handle: { provider: "e2b", runtimeId: "physical", metadata: { token: "secret-handle" } }, version: 7, stores: [], outputs: false, latestSnapshot: { status: "none" }, runStartedAt: 1, privateField: "do-not-export" };
  await runInDurableObject(stub, async (_, state) => { state.storage.kv.put("e2b_sandbox_state", record); });
  const query = new URLSearchParams({ environmentId, workId, generation: "2", holder: "worker" });
  const url = `http://localhost/v1/oma/operator/sessions/${sessionId}/physical-state?${query}`;
  const request = (headers: HeadersInit = { "x-api-key": "test-key" }, target = url, method = "GET") => new Request(target, { headers, method });
  return { sql, sessionId, environmentId, workId, stub, record, request, url };
}
it("projects the exact current Work and persisted physical handle without exposing secrets or changing DO state", async () => {
  const f = await fixture();
  const before = await runInDurableObject(f.stub, async (_, s) => ({ rows: [...s.storage.sql.exec("SELECT name FROM sqlite_master ORDER BY name")], alarm: await s.storage.getAlarm() }));
  const response = await exports.default.fetch(f.request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ type: "observed", source: "e2b_sandbox_state", physical: { phase: "running", provider: "e2b", runtimeId: "physical", version: 7 }, work: { workspaceId: "default", environmentId: f.environmentId, sessionId: f.sessionId, workId: f.workId, generation: 2, holder: "worker", state: "active" } });
  await runInDurableObject(f.stub, async (_, s) => { expect(s.storage.kv.get("e2b_sandbox_state")).toEqual(f.record); expect(await s.storage.getAlarm()).toBe(before.alarm); expect([...s.storage.sql.exec("SELECT name FROM sqlite_master ORDER BY name")]).toEqual(before.rows); });
});
it("denies unauthenticated and foreign-workspace observation including spoofed routing headers", async () => {
  const f = await fixture();
  expect((await exports.default.fetch(f.request({ "x-oma-workspace-id": "default" }))).status).toBe(401);
  const key = "foreign-observer-" + crypto.randomUUID();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.CONFIG_KV.put(`apikey:${hash}`, JSON.stringify({ tenant_id: "foreign" }));
  expect((await exports.default.fetch(f.request({ "x-api-key": key, "x-oma-workspace-id": "default" }))).status).toBe(404);
});
it.each(["generation", "holder", "environmentId", "workId", "expired", "archived", "missing"]) ("fails closed for %s", async kind => {
  const f = await fixture(), url = new URL(f.url);
  if (["generation", "holder", "environmentId", "workId"].includes(kind)) url.searchParams.set(kind, kind === "generation" ? "3" : "wrong");
  if (kind === "expired") await f.sql.prepare("UPDATE managed_environment_work SET claim_at=1 WHERE workspace_id='default' AND id=?").bind(f.workId).run();
  if (kind === "archived") await f.sql.prepare("UPDATE managed_sessions SET archived_at=1 WHERE workspace_id='default' AND id=?").bind(f.sessionId).run();
  if (kind === "missing") await runInDurableObject(f.stub, async (_, s) => { s.storage.kv.delete("e2b_sandbox_state"); });
  const response = await exports.default.fetch(f.request(undefined, url.toString()));
  expect([404, 409]).toContain(response.status);
  expect(await response.text()).not.toContain("physical");
});
it("direct DO observation still authenticates and binds the real DO identity", async () => {
  const f = await fixture();
  expect((await f.stub.fetch(f.request({}))).status).toBe(401);
  const other = env.SESSION_DO!.get(env.SESSION_DO!.idFromName(crypto.randomUUID()));
  expect((await other.fetch(f.request())).status).toBe(403);
});

it("cold observation does not bootstrap or migrate SessionDO SQL", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS cf_agents_runs (id TEXT)");
    const before = [...state.storage.sql.exec("SELECT name,sql FROM sqlite_master ORDER BY name")];
    const alarm = await state.storage.getAlarm();
    const cold = new SessionDO(state, env);
    expect((await cold.fetch(f.request())).status).toBe(200);
    expect([...state.storage.sql.exec("SELECT name,sql FROM sqlite_master ORDER BY name")]).toEqual(before);
    expect(await state.storage.getAlarm()).toBe(alarm);
  });
});
it.each(["POST", "HEAD", "PUT"])("rejects %s without observing", async method => {
  const f = await fixture();
  expect((await exports.default.fetch(f.request(undefined, f.url, method))).status).toBe(405);
});
it.each(["environment", "environment_work_session"])("rejects %s credentials", async type => {
  const f = await fixture(), key = "scoped-" + crypto.randomUUID();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.CONFIG_KV.put(`apikey:${hash}`, JSON.stringify({tenant_id:"default", credential:{type, environmentId:f.environmentId,sessionId:f.sessionId,workId:f.workId,generation:2}}));
  expect((await exports.default.fetch(f.request({authorization:"Bearer " + key}))).status).toBe(403);
});

it.each(["", " ", "x".repeat(513), "bad\u007fholder"])("rejects invalid holder length/control characters", async holder => {
 const f=await fixture(),url=new URL(f.url);url.searchParams.set("holder",holder);
 expect((await exports.default.fetch(f.request(undefined,url.toString()))).status).toBe(400);
});
it("rejects duplicated scope parameters", async () => {
 const f=await fixture();expect((await exports.default.fetch(f.request(undefined,f.url+"&holder=worker"))).status).toBe(400);
});

it("cookie-only observation is rejected before Console auth can create a tenant", async () => {
 const f=await fixture();
 const response=await exports.default.fetch(f.request({cookie:"better-auth.session_token=not-an-api-key"}));
 expect(response.status).toBe(401);expect(response.headers.get("cache-control")).toBe("no-store");
});
it.each(["work", "physical"])("refuses a %s change between the two reads", async kind => {
 const f=await fixture();
 await runInDurableObject(f.stub, async (_, state) => {
  const prepare=CfD1SqlClient.prototype.prepare;
  let reads=0;
  const spy=vi.spyOn(CfD1SqlClient.prototype,"prepare").mockImplementation(function(this: CfD1SqlClient, query) {
   const stmt=prepare.call(this,query);
   if(!query.startsWith("SELECT w.state"))return stmt;
   const bind=stmt.bind.bind(stmt);
   stmt.bind=(...args)=>{
    const bound=bind(...args),first=bound.first.bind(bound);
    bound.first=async <T>()=>{
     const result=await first<T>();
     if(++reads===(kind==="work"?1:2)) {
      if(kind==="work")await f.sql.prepare("UPDATE managed_environment_work SET revision=revision+1 WHERE id=?").bind(f.workId).run();
      else state.storage.kv.put("e2b_sandbox_state",{...f.record,version:8});
     }
     return result;
    };
    return bound;
   };
   return stmt;
  });
  try {
   const response=await handleWorkPhysicalObservation(f.request(),env,{storage:state.storage,id:state.id.toString()});
   expect(response.status).toBe(409);expect(await response.json()).toEqual({type:"changed"});
  } finally {spy.mockRestore();}
 });
});
it.each(["none", "paused", "lost", "released"])("reads %s as persisted state, never as native-running proof", async phase => {
 const f=await fixture();
 await runInDurableObject(f.stub,async(_,state)=>{state.storage.kv.put("e2b_sandbox_state",{...f.record,phase});});
 const response=await exports.default.fetch(f.request());
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({source:"e2b_sandbox_state",physical:{phase,provider:phase==="paused"?"e2b":null,runtimeId:phase==="paused"?"physical":null}});
});

it("normal schedule RPC initializes a cold SessionDO after read-only observation", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    const cold = new SessionDO(state, env);
    expect((await cold.fetch(f.request())).status).toBe(200);
    expect(cold.getSchedule("missing")).toBeUndefined();
    const scheduled = await cold.schedule(60, "recoverEventQueue", { test: true });
    expect(cold.getSchedule(scheduled.id)).toMatchObject({
      id: scheduled.id, callback: "recoverEventQueue", payload: { test: true },
    });
    await cold.cancelSchedule(scheduled.id);
  });
});
