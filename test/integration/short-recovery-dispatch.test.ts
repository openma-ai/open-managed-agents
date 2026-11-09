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


it.each(["recoverEventQueue", "recoverExecutionQueue", "alarm"])("%s returns while a claimed harness remains pending", async method => {
  const id = await createSession("hang-until-abort");
  await runInDurableObject(stubOf(id), instance => { instance._coldStartFlushDone = true; instance._runRecovery = instance._runRecovery.bind(instance); });
  const observed = await runInDurableObject(stubOf(id), async (instance, state) => {
    const event = { id: "input_" + id, type: "user.message", content: [{ type: "text", text: "hang" }] };
    instance.queue.enqueueQueueInput(event);
    let returned = false;
    const work = instance[method]().then(() => { returned = true; });
    await new Promise(resolve => setTimeout(resolve, 700));
    const snapshot = { returned, running: new SqliteHistory(state.storage.sql, null).getEvents().some(e => e.type === "session.status_running") };
    // Release the real harness through its normal interrupt path, including on RED.
    for (const controller of instance._threadAbortControllers.values()) controller.abort();
    await work;
    return snapshot;
  });
  expect(observed).toEqual({ returned: true, running: true });
}, 15000);

it("repeated alarms keep one lane owner and the pending input runs after completion", async () => {
  const id = await createSession("hang-until-abort");
  await send(id, message("hang"));
  await until(id, events => events.some(e => e.type === "agent.message"));
  await send(id, message("finish"));
  await runInDurableObject(stubOf(id), async (instance, state) => {
    await Promise.all([instance.alarm(), instance.alarm(), instance.recoverEventQueue(), instance.recoverExecutionQueue()]);
    const seen = new SqliteHistory(state.storage.sql, null).getEvents();
    expect(seen.filter(e => e.type === "session.status_running")).toHaveLength(1);
    expect(instance._recoveryRun).toBeNull();
    expect(instance._queueDrainFailures).toBe(0);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  await send(id, { type: "user.interrupt" });
  const seen = await until(id, events => events.filter(e => e.type === "session.status_idle").length === 2);
  expect(seen.filter(e => e.type === "session.status_running")).toHaveLength(2);
  expect(seen.filter(e => e.type === "session.status_idle")).toHaveLength(2);
  expect(seen.filter(e => e.type === "session.error")).toEqual([]);
}, 20000);

it("scheduled wakeup delivery returns before its harness and retains the durable wake", async () => {
  const id = await createSession("hang-until-abort");
  const snapshot = await runInDurableObject(stubOf(id), async (instance, state) => {
    await instance.onScheduledWakeup({ prompt: "hang", scheduled_at: new Date().toISOString(), kind: "one_shot" });
    await new Promise(resolve => setTimeout(resolve, 400));
    const seen = new SqliteHistory(state.storage.sql, null).getEvents();
    const result = { running: seen.some(e => e.type === "session.status_running"), alarm: await state.storage.getAlarm() };
    for (const controller of instance._threadAbortControllers.values()) controller.abort();
    return result;
  });
  expect(snapshot.running).toBe(true);
  expect(snapshot.alarm).not.toBeNull();
}, 15000);

it("observes detached claim rejection and keeps a retry wake", async () => {
  const id = await createSession("record-order");
  const snapshot = await runInDurableObject(stubOf(id), async (instance, state) => {
    instance.getExecutionStore = async () => { throw new Error("claim unavailable"); };
    instance.queue.enqueueQueueInput({ id: "reject_" + id, type: "user.message", content: [{ type: "text", text: "finish" }] });
    await instance.recoverEventQueue();
    await new Promise(resolve => setTimeout(resolve, 100));
    return { dispatched: instance._dispatchedLanes.size, alarm: await state.storage.getAlarm() };
  });
  expect(snapshot.dispatched).toBe(0);
  expect(snapshot.alarm).not.toBeNull();
}, 15000);

it("a pending lane does not block another lane dispatch or lease maintenance", async () => {
  const id = await createSession("hang-until-abort");
  await send(id, message("hang"));
  await until(id, events => events.some(e => e.type === "session.status_running"));
  await runInDurableObject(stubOf(id), async instance => {
    await instance.dispatchEventQueue("sthr_other");
    await instance.alarm();
    expect(instance._draining.has("sthr_primary")).toBe(true);
    expect(instance._recoveryRun).toBeNull();
    expect(instance._recoveryFailures).toBe(0);
  });
  await send(id, { type: "user.interrupt" });
  const seen = await until(id, events => events.some(e => e.type === "session.status_idle"));
  expect(seen.filter(e => e.type === "session.error")).toEqual([]);
}, 15000);

it("does not dispatch a cancelled queue input", async () => {
  const id = await createSession("record-order");
  const result = await runInDurableObject(stubOf(id), async (instance, state) => {
    instance.queue.enqueueQueueInput({ id: "cancelled_" + id, type: "user.message", content: [{ type: "text", text: "finish" }] });
    instance.queue.cancelQueueForThread("sthr_primary", Date.now());
    await instance.recoverEventQueue();
    await instance.alarm();
    return new SqliteHistory(state.storage.sql, null).getEvents().filter(e => e.type === "session.status_running");
  });
  expect(result).toEqual([]);
}, 15000);

it("late schedule maintenance owns deletion and cannot be delivered twice", async () => {
  const id = await createSession("record-order");
  const result = await runInDurableObject(stubOf(id), async (instance, state) => {
    let release;
    let calls = 0;
    instance.slowMaintenance = async () => { calls++; await new Promise(resolve => { release = resolve; }); };
    const schedule = await instance.schedule(0, "slowMaintenance");
    await instance.alarm(); // bounded 10s maintenance wait, not a model deadline
    expect(calls).toBe(1);
    expect(instance._maintenanceRuns.has("schedule:" + schedule.id)).toBe(true);
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    await instance.alarm();
    return { calls, pending: state.storage.sql.exec("SELECT id FROM cf_agents_schedules WHERE id=?", schedule.id).toArray().length };
  });
  expect(result).toEqual({ calls: 1, pending: 0 });
}, 20000);
