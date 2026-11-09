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

registerHarness("deadline-backoff", () => ({ async run() { throw new Error("temporary outage"); } }));
registerHarness("deadline-race", () => ({ async run(ctx) {
  await awaitDeadline(ctx, "race");
  if (ctx.userMessage.content[0].text === "reject") throw new Error("late harness rejection");
} }));

const settledExecutionLong = id => settledExecution(id, 800);
async function settledExecution(id, polls = 150) {
  for (let n = 0; n < polls; n++) {
    const rows = await env.MAIN_DB.prepare("SELECT state,failure FROM managed_session_executions WHERE session_id=?").bind(id).all();
    if (rows.results.length && rows.results.every(row => ["completed", "failed", "cancelled"].includes(row.state))) return rows.results;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("execution did not settle");
}

// From Sol's workerd counterexample: cleanup succeeds after the invocation has expired.
it.each(["memory", "dispose", "resolve", "reject"])("keeps public and durable outcomes consistent when %s crosses the model deadline", async kind => {
  const id = await createSession(["resolve", "reject"].includes(kind) ? "deadline-race" : "record-order");
  await runInDurableObject(stubOf(id), instance => {
    const alarm = instance.runAlarm.bind(instance);
    if (kind === "memory") instance.synchronizeManagedMemoryStores = async () => { await new Promise(r => setTimeout(r, 550)); };
    instance.alarm = async () => {
      const invocation = instance._turnInvocation = new TurnInvocation(300, 1800);
      if (kind === "dispose") {
        const cleanup = invocation.cleanup.bind(invocation);
        let calls = 0;
        invocation.cleanup = work => cleanup(async () => { const value = await work(); if (++calls === 3) await new Promise(r => setTimeout(r, 550)); return value; });
      }
      try { await alarm(); } finally { invocation.close(); instance._turnInvocation = null; }
    };
  });
  await send(id, message(kind));
  const settled = await settledExecution(id);
  const seen = await events(id);
  const terminal = seen.filter(e => e.type === "session.error" || e.type === "session.status_idle");
  const modelExpired = ["resolve", "reject"].includes(kind);
  expect(terminal.map(e => e.type)).toEqual(modelExpired ? ["session.error", "session.status_idle"] : ["session.status_idle"]);
  expect(terminal.at(-1).stop_reason.type).toBe(modelExpired ? "retries_exhausted" : "end_turn");
  expect(settled).toHaveLength(1);
  expect(settled[0].state).toBe(modelExpired ? "failed" : "completed");
  if (modelExpired) expect(settled[0].failure).toContain("invocation_deadline");
  else expect(settled[0].failure).toBeNull();
}, 30_000);
describe("characterization: SessionDO interrupt and lane drain", () => {
  it("reports a deadline during retry backoff before idle, never silent cancellation", async () => {
    const id = await createSession("deadline-backoff");
    await shortenInvocation(id);
    await send(id, message("start"));
    const seen = await until(id, e => e.some(x => x.type === "session.status_idle"));
    expect(seen.filter(e => e.type === "session.error").map(e => e.error.retry_status?.type ?? e.error.retry_status)).toEqual(["retrying", "exhausted"]);
    expect(JSON.stringify(seen.findLast(e => e.type === "session.error"))).toContain("invocation_deadline");
    expect(seen.at(-1).type).toBe("session.status_idle");
    expect(seen.at(-1).stop_reason.type).toBe("retries_exhausted");
    const settled = await settledExecution(id);
    expect(settled.length).toBeGreaterThan(0);
    expect(settled.every(e => e.state === "failed")).toBe(true);
  }, 30_000);
  it("renews the same attempt through successful cleanup and releases only after publication", async () => {
    const id = await createSession("record-order");
    const observation = { before: null, after: null, order: [] };
    await runInDurableObject(stubOf(id), instance => {
      const alarm = instance.runAlarm.bind(instance);
      instance.synchronizeManagedMemoryStores = async fence => {
        observation.order.push("sync");
        observation.before = await env.MAIN_DB.prepare("SELECT attempt_id,generation,lease_expires_at_ms FROM managed_session_executions WHERE session_id=?").bind(id).first();
        await new Promise(r => setTimeout(r, 30_700));
        observation.after = await env.MAIN_DB.prepare("SELECT attempt_id,generation,lease_expires_at_ms FROM managed_session_executions WHERE session_id=?").bind(id).first();
      };
      instance.publishAgentsApiArtifacts = async () => { observation.order.push("publish"); };
      const prepare = instance.doWarmUpSandbox.bind(instance);
      instance.doWarmUpSandbox = async () => { await prepare(); instance.portsSandbox = { endExecution: async () => { observation.order.push("release"); } }; };
      instance.alarm = async () => {
        const invocation = instance._turnInvocation = new TurnInvocation(300, 35_000);
        try { await alarm(); } finally { invocation.close(); instance._turnInvocation = null; }
      };
    });
    await send(id, message("start"));
    const settled = await settledExecutionLong(id);
    expect(settled[0].state, JSON.stringify({ settled, observation, events: await events(id) })).toBe("completed");
    expect(observation.order).toEqual(["sync", "publish", "release"]);
    expect(observation.after.attempt_id).toBe(observation.before.attempt_id);
    expect(observation.after.generation).toBe(observation.before.generation);
    expect(observation.after.lease_expires_at_ms).toBeGreaterThan(observation.before.lease_expires_at_ms);
    expect((await events(id)).filter(e => e.type === "session.error")).toEqual([]);
  }, 50_000);
  it.each(["cancel", "lost", "failure"])("does not publish or release a successful terminal after cleanup %s", async kind => {
    const id = await createSession("record-order");
    const order: string[] = [];
    let entered = false;
    await runInDurableObject(stubOf(id), instance => {
      instance.synchronizeManagedMemoryStores = async () => {
        entered = true;
        if (kind === "lost") {
          await env.MAIN_DB.prepare("UPDATE managed_session_executions SET generation=generation+1,owner_id='replacement' WHERE session_id=? AND state='running'").bind(id).run();
          instance._executionFences.clear();
          throw Object.assign(new Error("fence lost"), { name: "ExecutionFenceLostError" });
        }
        if (kind === "failure") throw new Error("memory publish failed");
        await new Promise(r => setTimeout(r, 550));
      };
      instance.publishAgentsApiArtifacts = async () => { order.push("publish"); };
      const prepare = instance.doWarmUpSandbox.bind(instance);
      instance.doWarmUpSandbox = async () => { await prepare(); instance.portsSandbox = { endExecution: async () => { order.push("release"); } }; };
    });
    await send(id, message("start"));
    for (let n = 0; n < 100 && !entered; n++) await new Promise(r => setTimeout(r, 25));
    expect(entered).toBe(true);
    if (kind === "cancel") await send(id, { type: "user.interrupt" });
    if (kind === "lost") for (let n = 0; n < 100; n++) {
      if (!await runInDurableObject(stubOf(id), instance => instance._executionActiveLanes.has("sthr_primary"))) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const settled = kind === "lost" ? (await env.MAIN_DB.prepare("SELECT state,generation,owner_id FROM managed_session_executions WHERE session_id=?").bind(id).all()).results : await settledExecution(id);
    const seen = await events(id);
    expect(order).toEqual([]);
    if (kind === "cancel") {
      expect(settled[0].state).toBe("cancelled");
      expect(seen.filter(e => e.type === "session.error")).toEqual([]);
      expect(seen.filter(e => e.type === "session.status_idle")).toHaveLength(1);
    } else if (kind === "lost") {
      expect(settled[0]).toMatchObject({ state: "running", generation: 2, owner_id: "replacement" });
      expect(seen.filter(e => e.type === "session.error" || e.type === "session.status_idle")).toEqual([]);
    } else {
      expect(settled[0].state).toBe("failed");
      expect(seen.filter(e => e.type === "session.error")).toHaveLength(1);
      expect(seen.filter(e => e.type === "session.status_idle").map(e => e.stop_reason.type)).toEqual(["retries_exhausted"]);
    }
  }, 30_000);
  it("bounds a hung cleanup RPC and still reports error before idle", async () => {
    const id = await createSession("record-order");
    await runInDurableObject(stubOf(id), instance => {
      const alarm = instance.runAlarm.bind(instance);
      instance.synchronizeManagedMemoryStores = () => instance._turnInvocation.cleanup(() => new Promise(() => {}));
      instance.alarm = async () => {
        const invocation = instance._turnInvocation = new TurnInvocation(1000, 100);
        try { await alarm(); } finally { invocation.close(); instance._turnInvocation = null; }
      };
    });
    await send(id, message("start"));
    const seen = await until(id, e => e.some(x => x.type === "session.status_idle"));
    expect(seen.filter(e => e.type === "session.error").some(e => JSON.stringify(e).includes("cleanup_deadline"))).toBe(true);
    expect(seen.at(-1).stop_reason.type).toBe("retries_exhausted");
    const settled = await settledExecution(id);
    expect(settled[0].state).toBe("failed");
    expect(seen.filter(e => e.type === "session.error")).toHaveLength(1);
    expect((await events(id)).filter(e => e.type === "session.status_idle")).toHaveLength(1);
  }, 30_000);
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
