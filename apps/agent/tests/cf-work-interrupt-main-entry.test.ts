import { env, exports } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, expect, it } from "vitest";
import main from "../../main/src/index";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkClaimPort } from "@open-managed-agents/environment-work-store-sql";

beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });

it.each(["queued", "starting", "active"] as const)("accepted interrupt fences %s Work, stale Session writes, bootstrap and recovery", async state => {
  const configured = { ...env, API_KEY: "test-key", PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo" };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const transport: typeof fetch = (input, init) => main.fetch(new Request(input, init), configured as never, ctx as never);
  async function post(path: string, body: unknown) {
    const response = await transport("https://control.test" + path, { method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status, await response.clone().text()).toBeLessThan(400);
    return response.json() as Promise<any>;
  }
  const agent = await post("/v1/agents", { name: "interrupt-" + crypto.randomUUID(), model: "unused", tools: [], _oma: { harness: "acp-sandbox", acp: { agent: { command: "/usr/local/bin/openma-pi-acp" } } } });
  const environment = await post("/v1/environments", { name: "interrupt-" + crypto.randomUUID(), config: { type: "cloud" } });
  const session = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id });
  const standing = await post("/v1/oma/api_keys", { name: "interrupt-worker", environment_id: environment.id });
  const client = new Anthropic({ apiKey: null, authToken: standing.key, baseURL: "https://control.test", maxRetries: 0, fetch: transport });
  const work = (await client.beta.environments.work.poll(environment.id, {}))!;
  expect(work.data.id).toBe(session.id);
  const secret = JSON.parse(atob(work.secret!));
  const claims = new SqlEnvironmentWorkClaimPort(new CfD1SqlClient(env.MAIN_DB));
  const claim = { workspaceId: "default", environmentId: environment.id, sessionId: session.id, workId: work.id, generation: secret.claim_generation, token: secret.sessions_token };
  expect((await claims.open(claim)).type).toBe("current");
  const owner = client.withOptions({ apiKey: null, authToken: secret.sessions_token });
  if (state !== "queued") await owner.beta.environments.work.ack(work.id, { environment_id: environment.id });
  if (state === "active") await owner.beta.environments.work.heartbeat(work.id, { environment_id: environment.id });
  const bearerRequest = (path: string, body?: unknown) => transport("https://control.test" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + secret.sessions_token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (state !== "queued") expect((await bearerRequest("/v1/sessions/" + session.id)).status).toBe(200);

  await post("/v1/sessions/" + session.id + "/events", { events: [{ type: "user.interrupt" }] });
  const row = await env.MAIN_DB.prepare("SELECT state,document FROM managed_environment_work WHERE workspace_id='default' AND id=?").bind(work.id).first<any>();
  expect(row.state).toBe(state === "queued" ? "stopped" : "stopping");
  expect(JSON.parse(row.document).stopRequestedAt).not.toBeNull();
  expect(await claims.open(claim)).toEqual({ type: "lost" });
  expect((await bearerRequest("/v1/sessions/" + session.id + "/events", { events: [{ type: "user.message", content: [{ type: "text", text: "stale" }] }] })).status).toBe(401);
  expect((await bearerRequest("/v1/sessions/" + session.id + "/runtime-events", { events: [] })).status).toBe(401);
  // Even a zero reclaim threshold cannot resurrect stopped/stopping work.
  expect(await client.beta.environments.work.poll(environment.id, { reclaim_older_than_ms: 0 })).toBeNull();
  if (state === "queued") {
    await expect(owner.beta.environments.work.ack(work.id, { environment_id: environment.id })).rejects.toMatchObject({ status: 401 });
  } else {
    const heartbeat = await owner.beta.environments.work.heartbeat(work.id, { environment_id: environment.id });
    expect(heartbeat.state).toBe("stopping");
    await owner.beta.environments.work.stop(work.id, { environment_id: environment.id, force: true });
    await expect(owner.beta.environments.work.heartbeat(work.id, { environment_id: environment.id })).rejects.toMatchObject({ status: 401 });
  }
});
