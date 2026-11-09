// @ts-nocheck
// SessionDO's interrupt handling and lane drain, driven through the public API
// and the DO event log, before they move behind Ports.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureModelCards } from "./_model-cards";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
const post = (path: string, body: any) =>
  exports.default.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: H, body: JSON.stringify(body) }));
const stubOf = (id: string) => env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", id])));
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
  registerHarness("confirmed-gone", () => ({async run(){const {SessionExecutionLostError}=await import("@open-managed-agents/session-runtime-contract/coordination");throw new SessionExecutionLostError("sandbox_gone");}}));
  registerHarness("record-order", () => ({
    async run(ctx) { texts.push(ctx.userMessage.content[0]?.text); },
  }));
});

async function createSession(harness: string, extra = {}) {
  const a = await post("/v1/oma/agents", { name: `host-${crypto.randomUUID()}`, model: "claude-sonnet-4-6", _oma: { harness }, ...extra });
  const e = await post("/v1/environments", { name: `env-${crypto.randomUUID()}`, config: { type: "cloud" } });
  const s = await post("/v1/sessions", { agent: ((await a.json()) as any).id, environment_id: ((await e.json()) as any).id });
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
const send = (id: string, event: any) => post(`/v1/sessions/${id}/events`, { events: [event] });
const message = (text: string) => ({ type: "user.message", content: [{ type: "text", text }] });
const lifecycle = (seen: any[]) => seen
  .filter((e) => e.type === "user.interrupt" || e.type === "session.status_running" || e.type === "session.status_idle")
  .map((e) => e.type === "session.status_idle" ? `idle:${e.stop_reason?.type}` : e.type);

describe("characterization: SessionDO interrupt and lane drain", () => {
  it("leaves a typed sandbox loss to the execution lease instead of reporting failed idle", async () => {
    const id=await createSession("confirmed-gone");
    await send(id,message("lost"));
    await until(id,e=>e.some(x=>x.type==="session.status_running"));
    await new Promise(r=>setTimeout(r,1000));
    const seen=await events(id);
    expect(seen.filter(e=>e.type==="session.error"||e.type==="session.status_idle")).toEqual([]);
  },30000);

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


it("starts accepted input without waiting for an alarm invocation", async () => {
  const id = await createSession("record-order");
  await runInDurableObject(stubOf(id), instance => { instance.alarm = async () => {}; });
  await send(id, message("detached drain"));
  const seen = await until(id, events => events.some(event => event.type === "session.status_idle"));
  expect(seen.filter(event => event.type === "session.status_idle").map(event => event.stop_reason.type)).toEqual(["end_turn"]);
  expect(seen.filter(event => event.type === "session.error")).toEqual([]);
}, 20000);

it("keeps normal cleanup attached to the execution fence without an alarm model timer", async () => {
  const id = await createSession("record-order");
  const order = [];
  await runInDurableObject(stubOf(id), instance => {
    instance.alarm = async () => {};
    instance.synchronizeManagedMemoryStores = async fence => {
      order.push("sync");
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(fence).toBeDefined();
    };
  });
  await send(id, message("cleanup"));
  const seen = await until(id, events => events.some(event => event.type === "session.status_idle"));
  expect(order).toEqual(["sync"]);
  expect(seen.filter(event => event.type === "session.error")).toEqual([]);
  expect(seen.filter(event => event.type === "session.status_idle").map(event => event.stop_reason.type)).toEqual(["end_turn"]);
}, 20000);

const settledExecutionLong = id => settledExecution(id, 800);
async function settledExecution(id, polls = 150) {
  for (let n = 0; n < polls; n++) {
    const rows = await env.MAIN_DB.prepare("SELECT state,failure FROM managed_session_executions WHERE session_id=?").bind(id).all();
    if (rows.results.length && rows.results.every(row => ["completed", "failed", "cancelled"].includes(row.state))) return rows.results;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("execution did not settle");
}


  it("renews the same attempt through successful cleanup and releases only after publication", async () => {
    const id = await createSession("record-order");
    const observation = { before: null, after: null, order: [] };
    await runInDurableObject(stubOf(id), instance => {
      instance.synchronizeManagedMemoryStores = async fence => {
        observation.order.push("sync");
        observation.before = await env.MAIN_DB.prepare("SELECT attempt_id,generation,lease_expires_at_ms FROM managed_session_executions WHERE session_id=?").bind(id).first();
        await new Promise(r => setTimeout(r, 30_700));
        observation.after = await env.MAIN_DB.prepare("SELECT attempt_id,generation,lease_expires_at_ms FROM managed_session_executions WHERE session_id=?").bind(id).first();
      };
      instance.publishAgentsApiArtifacts = async () => { observation.order.push("publish"); };
      const prepare = instance.doWarmUpSandbox.bind(instance);
      instance.doWarmUpSandbox = async () => { await prepare(); instance.portsSandbox = { endExecution: async () => { observation.order.push("release"); } }; };
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
