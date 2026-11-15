import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import mainApp from "../../apps/main/src/index";
import { beforeAll, expect, it } from "vitest";
import { earlyCustomModel } from "../../packages/agent-harness/test/early-custom-model";
import { PiHarness } from "../../packages/agent-harness/src/pi-loop";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import type { HarnessContext } from "../../packages/agent-harness/src/interface";
import { ensureModelCards } from "./_model-cards";

beforeAll(() => ensureModelCards(["early-test-model"]));

it.each([false, true])("Cloudflare earlyAll=%s accepts early custom replies on the actual SSE route while ordinary execution is blocked and reconnects without replay", async earlyAll => {
  let effects = 0;
  let release!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  let completed = false;
  const model = earlyCustomModel();
  const { faux, models } = model;
  const harnessId = `early-custom-${Date.now()}`;
  registerHarness(harnessId, () => ({ async run(ctx: HarnessContext) {
    await new PiHarness().run({ ...ctx,
      pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
      tools: { ...ctx.tools, bash: { ...ctx.tools.bash!, execute: async () => {
        effects++; entered = true;
        await latch; completed = true; return "ordinary completed";
      } } },
    });
  } }));
  const base = "http://localhost";
  const controllers: Array<{ abort(): Promise<void> }> = [];
  const readers: Promise<void>[] = [];
  const contexts: ReturnType<typeof createExecutionContext>[] = [];
  const streamEvents: any[] = [];
  const request = async (path: string, body?: unknown) => {
    const response = await exports.default.fetch(new Request(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const value = await response.json(); expect(response.ok, JSON.stringify(value)).toBe(true); return value as any;
  };
  const openStream = async (id: string) => {
    const controller = new AbortController();
    const context = createExecutionContext(); contexts.push(context);
    const response = await mainApp.fetch(new Request(`${base}/v1/sessions/${id}/events/stream`, { headers: { "x-api-key": "test-key" }, signal: controller.signal }), env, context);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    let disconnecting = false;
    const disconnect = { abort: async () => { disconnecting = true; await reader.cancel(); } }; controllers.push(disconnect);
    readers.push((async () => {
      let buffer = ""; const decoder = new TextDecoder();
      try { while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
          if (data) streamEvents.push(JSON.parse(data));
        }
      } } catch (error) { if (!disconnecting) throw error; }
    })());
    return disconnect;
  };
  try {
    const agent = await request("/v1/agents", { name: "early", model: "early-test-model", system: "test",
      _oma: { harness: harnessId }, tools: [{ type: "agent_toolset_20260401" }, { type: "custom", name: "approve", description: "answer",
        input_schema: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] } }] });
    const environment = await request("/v1/environments", { name: "early", config: { type: "cloud", networking: { type: "unrestricted" } } });
    const session = await request("/v1/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: environment.id });
    const eventsPath = `/v1/sessions/${session.id}/events`;
    const history = async () => (await request(eventsPath)).data as any[];
    const stream = await openStream(session.id); // MUST precede input.
    await request(eventsPath, { events: [{ type: "user.message", content: [{ type: "text", text: "mixed" }] }] });
    await expect.poll(() => streamEvents.filter(e => e.type === "agent.custom_tool_use").length).toBe(2);
    await expect.poll(() => entered).toBe(true);
    expect(completed).toBe(false);
    expect((await request(`/v1/sessions/${session.id}`)).status).toBe("running");
    const answer = (id: string) => request(eventsPath, { events: [{ type: "user.custom_tool_result", custom_tool_use_id: id, content: [{ type: "text", text: `answer:${id}` }] }] });
    const early = await answer("early-first");
    expect(early.data[0].processed_at).toBeTruthy();
    await answer("early-first");
    expect((await history()).filter(e => e.type === "user.custom_tool_result")).toHaveLength(2);
    if (earlyAll) await answer("early-last");
    expect(faux.state.callCount).toBe(1); expect(completed).toBe(false);
    await stream.abort(); await openStream(session.id);
    const rebuilt = new Map((await history()).map(e => [e.id, e]));
    for (const event of streamEvents) if (event.id) rebuilt.set(event.id, event);
    expect([...rebuilt.values()].filter(e => e.type === "agent.custom_tool_use")).toHaveLength(2);
    release();
    await expect.poll(async () => (await history()).some(e => e.type === "session.status_idle" && e.stop_reason?.type === "requires_action")).toBe(true);
    if (!earlyAll) expect(faux.state.callCount).toBe(1);
    expect((await history()).filter(e => e.type === "agent.tool_result" && e.tool_use_id === "ordinary")).toHaveLength(1);
    for (const controller of controllers) await controller.abort(); await Promise.all(readers);
    await openStream(session.id); await history();
    if (!earlyAll) await answer("early-last");
    await expect.poll(async () => (await history()).some(e => e.type === "agent.message" && JSON.stringify(e).includes("done after both answers")), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await request(`/v1/sessions/${session.id}`)).status).toBe("idle");
    await answer("early-first"); await answer("early-last");
    // Receipt/idle is not proof that late-answer continuations have settled.
    // Observe the real D1 execution queue before asserting no extra sample.
    await expect.poll(async () => (await env.MAIN_DB.prepare(
      "SELECT COUNT(*) AS pending FROM managed_session_executions WHERE session_id = ? AND state IN ('queued', 'running')",
    ).bind(session.id).first<{ pending: number }>())?.pending, { timeout: 15_000 }).toBe(0);
    expect(faux.state.callCount).toBe(2);
    expect(effects).toBe(1);
    expect(JSON.stringify(model.history())).toContain("answer:early-first");
    expect(JSON.stringify(model.history())).toContain("answer:early-last");
    expect(JSON.stringify(model.history())).toContain("ordinary completed");
  } finally {
    release(); for (const controller of controllers) await controller.abort();
    await Promise.all(readers);
    for (const context of contexts) await waitOnExecutionContext(context);
  }
}, 60_000);
