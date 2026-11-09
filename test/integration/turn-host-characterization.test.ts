// @ts-nocheck
// SessionDO's interrupt handling and lane drain, driven through the public API
// and the DO event log, before they move behind Ports.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureModelCards } from "./_model-cards";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { TurnInvocation } from "../../apps/agent/src/runtime/turn-invocation";
import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
const post = (path: string, body: any) =>
  exports.default.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: H, body: JSON.stringify(body) }));
const stubOf = (id: string) => env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
const texts: string[] = [];

beforeAll(async () => {
  await ensureModelCards(["claude-sonnet-4-6"]);
  registerHarness("hang-until-abort", () => ({
    async run(ctx) {
      const text = ctx.userMessage.content[0]?.text;
      texts.push(text);
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: `started ${text}` }] });
      if (text === "finish") return;
      await new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (ctx.runtime.abortSignal.aborted) fail();
        else ctx.runtime.abortSignal.addEventListener("abort", fail, { once: true });
      });
    },
  }));
  registerHarness("record-order", () => ({
    async run(ctx) { texts.push(ctx.userMessage.content[0]?.text); },
  }));
});

async function createSession(harness: string, extra = {}) {
  const a = await post("/v1/oma/agents", { name: `host-${crypto.randomUUID()}`, model: "claude-sonnet-4-6", _oma: { harness }, ...extra });
  const e = await post("/v1/oma/environments", { name: `env-${crypto.randomUUID()}`, config: { type: "cloud" } });
  const s = await post("/v1/oma/sessions", { agent: ((await a.json()) as any).id, environment_id: ((await e.json()) as any).id });
  const id = ((await s.json()) as any).id as string;
  await runInDurableObject(stubOf(id), (instance: any) => instance._sandboxWarm);
  return id;
}
const events = (id: string): Promise<any[]> => runInDurableObject(stubOf(id), async (_i, state) =>
  new SqliteHistory(state.storage.sql, null).getEvents() as any[]);
async function until(id: string, pred: (e: any[]) => boolean) {
  for (let t = 0; t < 15_000; t += 100) {
    const seen = await events(id);
    if (pred(seen)) return seen;
    await new Promise((r) => setTimeout(r, 100));
  }
  return events(id);
}
const send = (id: string, event: any) => post(`/v1/oma/sessions/${id}/events`, { events: [event] });
const message = (text: string) => ({ type: "user.message", content: [{ type: "text", text }] });
const lifecycle = (seen: any[]) => seen
  .filter((e) => e.type === "user.interrupt" || e.type === "session.status_running" || e.type === "session.status_idle")
  .map((e) => e.type === "session.status_idle" ? `idle:${e.stop_reason?.type}` : e.type);

const cancelled = new Set<string>();
registerHarness("deadline-revision", () => ({
  async run(ctx) {
    if (!ctx.userMessage.content[0].text.includes("<outcome_feedback")) {
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "first attempt" }] });
      return;
    }
    await awaitDeadline(ctx, "revision");
  },
}));
registerHarness("deadline-child", () => ({ async run(ctx) { await awaitDeadline(ctx, "child"); } }));
registerHarness("deadline-parent", () => ({ async run(ctx) {
  await ctx.env.delegateToAgent(ctx.agent.multiagent.subagents.predefined_agents[0].id, "work");
} }));
async function awaitDeadline(ctx, label) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test work was not cancelled")), 4000);
    const abort = () => { clearTimeout(timer); cancelled.add(label); resolve(); };
    if (ctx.runtime.abortSignal.aborted) abort();
    else ctx.runtime.abortSignal.addEventListener("abort", abort, { once: true });
  });
}
async function shortenInvocation(id) {
  await runInDurableObject(stubOf(id), (instance: any) => {
    const alarm = instance.runAlarm.bind(instance);
    instance.alarm = async () => {
      const invocation = instance._turnInvocation = new TurnInvocation(1500);
      try { await alarm(); } finally { invocation.close(); instance._turnInvocation = null; }
    };
  });
}

describe("characterization: SessionDO interrupt and lane drain", () => {
  it.each(["revision", "child", "judge", "tool"])("cancels %s with the invocation and reports deadline before idle", async (kind) => {
    cancelled.delete(kind);
    let extra = kind === "tool" ? { tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true } }] } : {};
    if (kind === "child") {
      const child = await (await post("/v1/oma/agents", { name: "deadline-child", model: "claude-sonnet-4-6", _oma: { harness: "deadline-child" } })).json();
      extra = { multiagent: { type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" }, subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [{ type: "agent", id: child.id, version: child.version }] } } };
    }
    const id = await createSession(kind === "child" ? "deadline-parent" : kind === "judge" ? "deadline-judge" : kind === "tool" ? "deadline-tool" : "deadline-revision", extra);
    await shortenInvocation(id);
    if (kind === "judge") await runInDurableObject(stubOf(id), instance => instance.setState({ ...instance.state, outcome: { outcome_id: "deadline-judge", description: "deadline-judge", rubric: { type: "text", content: "deadline-judge" }, max_iterations: 3 } }));
    if (kind === "revision") await runInDurableObject(stubOf(id), instance => instance.setState({ ...instance.state, outcome: { outcome_id: "deadline-outcome", description: "write file", verifier: { type: "verifiable", scorer: "fileWritten", opts: { path: "/workspace/missing.txt" } }, max_iterations: 3 } }));
    await send(id, message("start"));
    const seen = await until(id, e => e.some(x => x.type === "session.status_idle" && (x.session_thread_id ?? "sthr_primary") === "sthr_primary"));
    expect(cancelled.has(kind), "work must observe abort, not time out independently").toBe(true);
    const endings = seen.filter(e => e.type === "session.error" || (e.type === "session.status_idle" && (e.session_thread_id ?? "sthr_primary") === "sthr_primary"));
    expect(endings.map(e => e.type)).toEqual(["session.error", "session.status_idle"]);
    expect(JSON.stringify(endings[0])).toContain("wall-time budget");
    expect(endings[1].stop_reason.type).toBe("retries_exhausted");
  }, 30_000);

  it("keeps the alarm open until its turn finishes and errors before its wall-time budget", async () => {
    const id = await createSession("hang-until-abort");
    // Replace the infrastructure budget only; exercise the real alarm, drain,
    // harness and public error settlement without waiting thirteen minutes.
    await runInDurableObject(stubOf(id), (instance: any) => {
      const alarm = instance.runAlarm.bind(instance);
      instance.alarm = async () => {
        const invocation = instance._turnInvocation = new TurnInvocation(1000);
        try { await alarm(); }
        finally { invocation.close(); instance._turnInvocation = null; }
      };
    });
    await send(id, message("hang"));
    const seen = await until(id, e => e.some(x => x.type === "session.status_idle"));
    expect(seen.some(e => e.type === "session.error" && JSON.stringify(e).includes("wall-time budget"))).toBe(true);
    expect(seen.filter(e => e.type === "session.status_idle").map(e => e.stop_reason.type)).toEqual(["retries_exhausted"]);
    await send(id, message("finish"));
    const second = await until(id, e => e.filter(x => x.type === "session.status_idle").length === 2);
    expect(second.filter(e => e.type === "session.status_idle").at(-1).stop_reason.type).toBe("end_turn");
  }, 30_000);

  it("interrupting a running turn ends it once with idle end_turn", async () => {
    const id = await createSession("hang-until-abort");
    await send(id, message("hang"));
    await until(id, (e) => e.some((x) => x.type === "agent.message"));
    expect((await send(id, { type: "user.interrupt" })).status).toBeLessThan(300);
    const seen = await until(id, (e) => e.some((x) => x.type === "session.status_idle"));
    await new Promise((r) => setTimeout(r, 500));
    expect(lifecycle(await events(id))).toEqual(["session.status_running", "user.interrupt", "idle:end_turn"]);
    expect(seen.filter((e) => e.type === "session.error")).toEqual([]);
  }, 30_000);

  it("a second interrupt on the now idle session is recorded and changes nothing else", async () => {
    const id = await createSession("hang-until-abort");
    await send(id, message("finish"));
    await until(id, (e) => e.some((x) => x.type === "session.status_idle"));
    await send(id, { type: "user.interrupt" });
    await until(id, (e) => e.some((x) => x.type === "user.interrupt"));
    expect(lifecycle(await events(id))).toEqual(["session.status_running", "idle:end_turn", "user.interrupt"]);
  }, 30_000);

  it("a message queued before an interrupt still runs as the next turn", async () => {
    const id = await createSession("hang-until-abort");
    texts.length = 0;
    await send(id, message("hang"));
    await until(id, (e) => e.some((x) => x.type === "agent.message"));
    await send(id, message("finish"));
    await send(id, { type: "user.interrupt" });
    await until(id, (e) => e.filter((x) => x.type === "session.status_idle").length >= 2);
    expect(texts).toEqual(["hang", "finish"]);
    expect(lifecycle(await events(id))).toEqual([
      "session.status_running", "user.interrupt", "idle:end_turn",
      "session.status_running", "idle:end_turn",
    ]);
  }, 30_000);

  it("drains queued messages one turn at a time, in order", async () => {
    const id = await createSession("record-order");
    texts.length = 0;
    for (const text of ["one", "two", "three"]) await send(id, message(text));
    await until(id, (e) => e.filter((x) => x.type === "session.status_idle").length >= 3);
    expect(texts).toEqual(["one", "two", "three"]);
    expect(lifecycle(await events(id))).toEqual([
      "session.status_running", "idle:end_turn",
      "session.status_running", "idle:end_turn",
      "session.status_running", "idle:end_turn",
    ]);
  }, 30_000);
});

// The harness and judge share this model object; replace only judge model I/O.
registerHarness("deadline-judge", () => ({ async run(ctx) {
  ctx.model.doGenerate = async options => {
    await awaitDeadline({ runtime: { abortSignal: options.abortSignal } }, "judge");
    return { content: [{ type: "text", text: JSON.stringify({ result: "satisfied", explanation: "done" }) }], finishReason: { unified: "stop", raw: "end_turn" }, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } }, warnings: [] };
  };
  ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "first attempt" }] });
} }));

registerHarness("deadline-tool", () => ({ async run(ctx) {
  await ctx.tools.web_fetch.execute({ url: "https://deadline-tool.example.com/" }, { toolCallId: "deadline-tool", messages: [], abortSignal: ctx.runtime.abortSignal });
} }));
const originalFetch = globalThis.fetch;
beforeAll(() => vi.stubGlobal("fetch", async (input, init) => {
  if (!String(input).includes("deadline-tool.example.com")) return originalFetch(input, init);
  await awaitDeadline({ runtime: { abortSignal: init.signal } }, "tool");
  return new Response("cancelled", { headers: { "content-type": "text/plain" } });
}));
afterAll(() => vi.unstubAllGlobals());
