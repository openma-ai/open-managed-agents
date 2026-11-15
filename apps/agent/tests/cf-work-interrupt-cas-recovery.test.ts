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

it.each(["ack", "claim", "heartbeat", "terminal"])("stop CAS re-reads after real SDK %s interleaving without duplicate input", async race => {
  const f = await setup();
  if (["heartbeat", "terminal"].includes(race)) await f.owner.beta.environments.work.ack(f.work.id, { environment_id: f.environment.id });
  const message = await f.post("/v1/sessions/" + f.session.id + "/events", { events: [{ type: "user.message", content: [{ type: "text", text: "accepted-before-interrupt" }] }] });
  const original = SqlEnvironmentWorkStore.prototype.replace;
  let injected = false;
  const spy = vi.spyOn(SqlEnvironmentWorkStore.prototype, "replace").mockImplementation(async function(input) {
    if (!injected && input.workId === f.work.id && input.next.work.stopRequestedAt) {
      injected = true;
      if (race === "ack") await f.owner.beta.environments.work.ack(f.work.id, { environment_id: f.environment.id });
      if (race === "claim") await f.client.beta.environments.work.poll(f.environment.id, { reclaim_older_than_ms: 0 });
      if (race === "heartbeat") await f.owner.beta.environments.work.heartbeat(f.work.id, { environment_id: f.environment.id });
      if (race === "terminal") await f.owner.beta.environments.work.stop(f.work.id, { environment_id: f.environment.id, force: true });
    }
    return original.call(this, input);
  });
  try {
    const first = await sendInterrupt(f);
    expect(injected).toBe(true);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const retry = await sendInterrupt(f);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstBody);
    expect(await state(f)).toBe(["claim", "terminal"].includes(race) ? "stopped" : "stopping");
    const events = await history(f);
    expect(events.filter((event: any) => event.type === "user.interrupt")).toHaveLength(1);
    expect(events.find((event: any) => event.id === message.data[0].id)).toEqual(message.data[0]);
    expect(message.data[0].processed_at).toBeNull();
    expect(await f.client.beta.environments.work.poll(f.environment.id, { reclaim_older_than_ms: 0 })).toBeNull();
  } finally { spy.mockRestore(); }
});

it("exhausted stop CAS remains recoverable by the same accepted interrupt key", async () => {
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
  try {
    expect((await sendInterrupt(f)).status).toBe(500);
    expect(collisions).toBeGreaterThan(0);
    expect(collisions).toBeLessThanOrEqual(5);
    // Persistent contention must not turn the next replay into false success.
    expect((await sendInterrupt(f)).status).toBe(500);
    expect((await history(f)).filter((event:any) => event.type === "user.interrupt")).toHaveLength(1);
    spy.mockRestore();
    expect((await sendInterrupt(f)).status).toBe(200);
    expect(await state(f)).toBe("stopping");
    expect((await history(f)).filter((event:any) => event.type === "user.interrupt")).toHaveLength(1);
    await f.owner.beta.environments.work.stop(f.work.id, { environment_id: f.environment.id, force: true });
    expect((await sendInterrupt(f)).status).toBe(200);
    expect(await state(f)).toBe("stopped");
    expect(await f.client.beta.environments.work.poll(f.environment.id, { reclaim_older_than_ms: 0 })).toBeNull();
  } finally { spy.mockRestore(); }
});


it("an old duplicate interrupt does not cancel later Work or change accepted input facts", async () => {
  const f = await setup();
  const first = await sendInterrupt(f);
  expect(first.status).toBe(200);
  const before = await history(f);
  expect(before[0].processed_at).toBeNull();
  const newerId = "work_" + crypto.randomUUID();
  const newerAt = Date.now() + 60_000;
  await env.MAIN_DB.prepare(
    "INSERT INTO managed_environment_work (workspace_id,environment_id,id,session_id,document,sealed_secret,claim_at,claim_worker_id,claim_generation,heartbeat_ttl_seconds,revision,state,created_at) " +
    "SELECT workspace_id,environment_id,?,session_id,json_set(document,'$.id',?,'$.state','queued','$.stopRequestedAt',NULL,'$.stoppedAt',NULL,'$.createdAt',?),sealed_secret,NULL,NULL,0,90,1,'queued',? FROM managed_environment_work WHERE id=?"
  ).bind(newerId, newerId, new Date(newerAt).toISOString(), newerAt, f.work.id).run();
  expect((await sendInterrupt(f)).status).toBe(200);
  expect(await history(f)).toEqual(before);
  const newer = await env.MAIN_DB.prepare("SELECT state,revision FROM managed_environment_work WHERE id=?").bind(newerId).first<any>();
  expect(newer).toEqual({ state: "queued", revision: 1 });
  expect(await state(f)).toBe("stopped");
});
