import { env, exports } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, expect, it } from "vitest";
import main from "../../main/src/index";
import { createDispatchedManagedEnvironmentWorker } from "../../../packages/managed-runtime-host/src/dispatched-environment-worker";

beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });

async function fixture() {
  const configured = { ...env, API_KEY: "test-key", PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo" };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const requests: { url: string; status: number }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await main.fetch(request, configured as never, ctx as never);
    requests.push({ url: request.url, status: response.status });
    return response;
  };
  async function post(path: string, body: unknown) {
    const response = await transport("https://control.test" + path, { method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json() as Promise<any>;
  }
  const environment = await post("/v1/environments", { name: "sdk-poll-" + crypto.randomUUID(), config: { type: "cloud" } });
  const credential = await post("/v1/oma/api_keys", { name: "sdk-poll", environment_id: environment.id });
  const client = new Anthropic({ apiKey: null, authToken: credential.key, baseURL: "https://control.test", maxRetries: 0, fetch: transport });
  return { environment, client, requests, environmentKey: credential.key };
}

it("SDK null block_ms serializes to empty query and real main rejects it without relaxing the API", async () => {
  const f = await fixture();
  await expect(f.client.beta.environments.work.poll(f.environment.id, { block_ms: null })).rejects.toMatchObject({ status: 400 });
  expect(f.requests.at(-1)).toEqual({ url: "https://control.test/v1/environments/" + f.environment.id + "/work/poll?block_ms=", status: 400 });
});

it("bounded dispatched drain uses SDK nonblocking default against real main and D1", async () => {
  const f = await fixture();
  const worker = createDispatchedManagedEnvironmentWorker({
    client: f.client, environmentId: f.environment.id, environmentKey: f.environmentKey,
    workspaceId: "default", maxWorkItemsPerDrain: 1,
    dispatch: { descriptor: () => ({ provider: "test", version: "1", strategy: "poll_unacked_then_dispatch" }), async dispatch() { throw new Error("Empty queue must not dispatch"); } },
  });
  await worker.drain();
  expect(f.requests.at(-1)).toEqual({ url: "https://control.test/v1/environments/" + f.environment.id + "/work/poll", status: 200 });
});
