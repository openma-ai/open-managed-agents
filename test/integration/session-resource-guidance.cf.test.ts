// CF SessionDO reachability for Session resource guidance: a real managed
// Session (main worker routes + SessionDO processUserMessage + warmup) with a
// deterministic capture harness instead of a model. Proves the prompt the
// harness receives carries the Memory facts the DO mounted; it does not
// prove agent behaviour (no inference) or container mount IO.
// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { ensureModelCards } from "./_model-cards";

const headers = { "x-api-key": "test-key", "content-type": "application/json" };
async function api(path, body) {
  const response = await exports.default.fetch(new Request("http://localhost" + path, {
    headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  }));
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json();
}

beforeAll(async () => {
  await ensureModelCards(["claude-sonnet-4-6"]);
  registerHarness("resource-guidance-capture", () => ({ async run(ctx) {
    const blocks = [...ctx.systemPrompt.matchAll(/<source name="(memory:[^"]+|skill_files:[^"]+|session_outputs)">\n([\s\S]*?)\n<\/source>/g)]
      .map((match) => ({ source: match[1], text: match[2] }));
    const outputsMentions = ctx.systemPrompt.split("`/mnt/session/outputs/`").length - 1;
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "GUIDANCE:" + JSON.stringify({ blocks, outputsMentions, diag: { memoryStoreIds: ctx.env?.memoryStoreIds, sources: [...ctx.systemPrompt.matchAll(/<source name="([^"]+)">/g)].map((m) => m[1]) } }) }] });
  } }));
});

describe("CF SessionDO resource guidance", () => {
  it("puts the mounted Memory Store facts into the harness system prompt", async () => {
    const store = await api("/v1/memory_stores", { name: "guide-notes", description: "Guidance test notes" });
    const agent = await api("/v1/oma/agents", { name: "resource-guidance", model: "claude-sonnet-4-6", _oma: { harness: "resource-guidance-capture" } });
    const environment = await api("/v1/environments", { name: "resource-guidance", config: { type: "cloud" } });
    const session = await api("/v1/sessions", {
      agent: agent.id, environment_id: environment.id,
      resources: [{ type: "memory_store", memory_store_id: store.id, access: "read_only", instructions: "Read before acting." }],
    });
    // The test worker binds MEMORY_BUCKET (bucket "test-memory") but not its
    // name var; managed Memory refuses to start without it (no fallback).
    // Supply the inert matching name on this DO only; the requirement stays.
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
    await runInDurableObject(stub, (instance) => { instance.env.MEMORY_BUCKET_NAME = "test-memory"; });
    await api("/v1/sessions/" + session.id + "/events", { events: [{ type: "user.message", content: [{ type: "text", text: "show guidance" }] }] });
    let captured;
    await expect.poll(async () => {
      const events = (await api("/v1/sessions/" + session.id + "/events?limit=100")).data;
      const text = events.flatMap((e) => e.type === "agent.message" ? e.content : []).map((c) => c.text).find((t) => t?.startsWith("GUIDANCE:"));
      captured = text ? JSON.parse(text.slice("GUIDANCE:".length)) : undefined;
      return captured !== undefined;
    }, { timeout: 15000 }).toBe(true);
    console.log("RESOURCE_GUIDANCE_DIAG", JSON.stringify(captured.diag));
    expect(captured.blocks).toEqual([{
      source: `memory:${store.id}`,
      text: "## Memory store: guide-notes\nMounted at /mnt/memory/guide-notes/ (read-only)\nGuidance test notes\nRead before acting.\n(read-only mount — write attempts to this directory will fail)",
    }]);
    expect(captured.outputsMentions).toBe(1);
  });
});
