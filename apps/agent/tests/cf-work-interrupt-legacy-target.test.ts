import { env, exports } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, it, expect, vi } from "vitest";
import main from "../../main/src/index";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";

beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });

async function setup() {
  const configured = { ...env, API_KEY: "test-key", PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo" };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const transport: typeof fetch = (raw, init) => main.fetch(new Request(raw, init), configured as never, ctx as never);
  async function post(path: string, body: unknown) {
    const response = await transport("https://control.test" + path, {
      method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBeLessThan(400);
    return response.json() as Promise<any>;
  }
  const agent = await post("/v1/agents", {
    name: "cas-" + crypto.randomUUID(), model: "unused", tools: [],
    _oma: { harness: "acp-sandbox", acp: { agent: { command: "/usr/local/bin/openma-pi-acp" } } },
  });
  const environment = await post("/v1/environments", { name: "cas-" + crypto.randomUUID(), config: { type: "cloud" } });
  const session = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id });
  const standing = await post("/v1/oma/api_keys", { name: "cas-worker", environment_id: environment.id });
  const client = new Anthropic({ apiKey: null, authToken: standing.key, baseURL: "https://control.test", maxRetries: 0, fetch: transport });
  const work = (await client.beta.environments.work.poll(environment.id, {}))!;
  const secret = JSON.parse(atob(work.secret!));
  const owner = client.withOptions({ apiKey: null, authToken: secret.sessions_token });
  return { post, transport, environment, session, client, work, owner };
}

async function sendInterrupt(f: Awaited<ReturnType<typeof setup>>, key = "interrupt-once") {
  return f.transport("https://control.test/v1/sessions/" + f.session.id + "/events", {
    method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ events: [{ type: "user.interrupt" }] }),
  });
}
async function state(f: Awaited<ReturnType<typeof setup>>) {
  return (await env.MAIN_DB.prepare("SELECT state FROM managed_environment_work WHERE id=?").bind(f.work.id).first<{state:string}>())!.state;
}
async function history(f: Awaited<ReturnType<typeof setup>>) {
  const response = await f.transport("https://control.test/v1/sessions/" + f.session.id + "/events", { headers: { "x-api-key": "test-key" } });
  return (await response.json() as any).data;
}

it.each(["missing", "bound"])("accepted interrupt recovery distinguishes %s target without guessing another Work", async mode => {
  const f = await setup();
  await f.owner.beta.environments.work.ack(f.work.id, { environment_id: f.environment.id });
  const original = SqlEnvironmentWorkStore.prototype.replace;
  let collisions = 0;
  const spy = vi.spyOn(SqlEnvironmentWorkStore.prototype, "replace").mockImplementation(async function(input) {
    if (input.workId === f.work.id && input.next.work.stopRequestedAt) {
      collisions++;
      await f.owner.beta.environments.work.heartbeat(f.work.id, { environment_id: f.environment.id });
    }
    return original.call(this, input);
  });
  try { expect((await sendInterrupt(f)).status).toBe(500); expect(collisions).toBe(3); }
  finally { spy.mockRestore(); }
  if (mode === "missing") await env.MAIN_DB.prepare("UPDATE managed_session_events SET document=json_remove(document,'$.environmentWorkId') WHERE session_id=? AND type='user.interrupt'").bind(f.session.id).run();
  const before = await env.MAIN_DB.prepare("SELECT id,document,processed_at FROM managed_session_events WHERE session_id=?").bind(f.session.id).all();
  const workBefore = await env.MAIN_DB.prepare("SELECT * FROM managed_environment_work WHERE id=?").bind(f.work.id).first();
  const retry = await sendInterrupt(f);
  if (mode === "missing") {
    expect(retry.status).toBe(500);
    // The HTTP boundary deliberately redacts internal errors; the shared
    // router error below identifies the unrecoverable missing target.
    expect(await retry.text()).toBe("Internal Server Error");
    expect((await sendInterrupt(f)).status).toBe(500);
    expect(await env.MAIN_DB.prepare("SELECT * FROM managed_environment_work WHERE id=?").bind(f.work.id).first()).toEqual(workBefore);
  } else {
    expect(retry.status).toBe(200);
    expect(await state(f)).toBe("stopping");
  }
  expect(await env.MAIN_DB.prepare("SELECT id,document,processed_at FROM managed_session_events WHERE session_id=?").bind(f.session.id).all()).toEqual(before);
});

it("explicit null accepted target remains a no-op after later Work appears", async () => {
  const f = await setup();
  await f.client.beta.environments.work.stop(f.work.id, { environment_id: f.environment.id, force: true });
  expect((await sendInterrupt(f)).status).toBe(200);
  const event = await env.MAIN_DB.prepare("SELECT document FROM managed_session_events WHERE session_id=? AND type='user.interrupt'").bind(f.session.id).first<any>();
  expect(JSON.parse(event.document).environmentWorkId).toBeNull();
  await env.MAIN_DB.prepare("UPDATE managed_environment_work SET state='queued',revision=revision+1,document=json_set(document,'$.state','queued') WHERE id=?").bind(f.work.id).run();
  const before = await env.MAIN_DB.prepare("SELECT * FROM managed_environment_work WHERE id=?").bind(f.work.id).first();
  expect((await sendInterrupt(f)).status).toBe(200);
  expect(await env.MAIN_DB.prepare("SELECT * FROM managed_environment_work WHERE id=?").bind(f.work.id).first()).toEqual(before);
});

it.each(["environmentWorkId", "environment_work_id"])("HTTP rejects forged internal %s target", async field => {
  const f = await setup();
  const response = await f.transport("https://control.test/v1/sessions/" + f.session.id + "/events", { method:"POST", headers:{"x-api-key":"test-key","content-type":"application/json"}, body:JSON.stringify({events:[{type:"user.interrupt",[field]:f.work.id}]}) });
  expect(response.status).toBe(400);
  expect(await history(f)).toEqual([]);
});


it("shared recovery reports missing identity explicitly before any Work stop", async () => {
  const { EnvironmentAwareSessionEventDispatchRouter } = await import("../../../packages/managed-agents-adapters-runtime/src/session-lifecycle-router");
  const router = new EnvironmentAwareSessionEventDispatchRouter({
    runtime: { async sessionEventsAccepted() { throw new Error("Unexpected host dispatch"); } },
    selfHostedWork: { async stop() { throw new Error("Must not guess a Work target"); } },
  });
  await expect(router.reconcileAcceptedInterrupts({ workspaceId:"default", sessionId:"legacy", session:{agent:{openma:{harness:"acp-sandbox"}}} as never, environment:{config:{type:"cloud"}} as never, events:[{type:"user.interrupt",id:"accepted-legacy",processedAt:null}] })).rejects.toThrow("Cannot safely recover interrupt: missing its accepted Environment Work target");
});
