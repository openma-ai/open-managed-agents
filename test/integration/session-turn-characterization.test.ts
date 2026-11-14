// @ts-nocheck
// One Cloudflare turn's failure handling, driven through the public API.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureModelCards } from "./_model-cards";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
const post = (path: string, body: any) =>
  exports.default.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: H, body: JSON.stringify(body) }));
const stubOf = (id: string) => env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
let runs = 0;

beforeAll(async () => {
  await ensureModelCards(["claude-sonnet-4-6"]);
  registerHarness("crash-after-agent-event", () => ({
    async run(ctx) {
      runs += 1;
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "partial" }] });
      throw new Error("crash after agent event");
    },
  }));
  registerHarness("fail-then-finish", () => ({
    async run() { runs += 1; if (runs === 1) throw new Error("transient blip"); },
  }));
  registerHarness("always-fail", () => ({
    async run() { runs += 1; throw new Error("transient blip"); },
  }));
  registerHarness("auth-fail", () => ({
    async run() { runs += 1; throw new Error("401 unauthorized"); },
  }));
  registerHarness("park-two", () => ({
    async run(ctx) {
      runs += 1;
      if (runs > 1) return;
      for (const id of ["sevt_call_a", "sevt_call_b"]) {
        ctx.runtime.broadcast({ type: "agent.custom_tool_use", id, name: "lookup", input: {} });
        ctx.runtime.pendingConfirmations.push(id);
      }
    },
  }));
});

async function createSession(harness: string) {
  const a = await post("/v1/oma/agents", { name: `turn-${Date.now()}`, model: "claude-sonnet-4-6", _oma: { harness } });
  const e = await post("/v1/oma/environments", { name: `env-${Date.now()}`, config: { type: "cloud" } });
  const s = await post("/v1/oma/sessions", { agent: ((await a.json()) as any).id, environment_id: ((await e.json()) as any).id });
  const id = ((await s.json()) as any).id as string;
  await runInDurableObject(stubOf(id), (instance: any) => instance._sandboxWarm);
  return id;
}
const events = (id: string): Promise<any[]> => runInDurableObject(stubOf(id), async (_i, state) =>
  new SqliteHistory(state.storage.sql, null).getEvents() as any[]);

const send = (id: string, event: any) => post(`/v1/oma/sessions/${id}/events`, { events: [event] });
const go = { type: "user.message", content: [{ type: "text", text: "go" }] };
const answer = (call: string) => ({ type: "user.custom_tool_result", custom_tool_use_id: call, content: [{ type: "text", text: "42" }] });
const idles = (seen: any[]) => seen.filter((e) => e.type === "session.status_idle").map((e) => e.stop_reason);
const retryStatuses = (seen: any[]) => seen.filter((e) => e.type === "session.error").map((e) => e.error.retry_status);
async function until(id: string, done: (seen: any[]) => boolean, ms = 20_000) {
  let seen: any[] = [];
  for (let t = 0; t < ms; t += 100) {
    seen = await events(id);
    if (done(seen)) return seen;
    await new Promise((r) => setTimeout(r, 100));
  }
  return seen;
}

describe("characterization: one Cloudflare turn", () => {
  it("re-runs a side-effect-free failure and ends the turn once", async () => {
    const id = await createSession("fail-then-finish");
    runs = 0;
    await send(id, go);
    const seen = await until(id, (e) => e.some((x) => x.type === "session.status_idle"));
    expect(runs).toBe(2);
    expect(retryStatuses(seen)).toEqual(["retrying"]);
    expect(seen.filter((e) => e.type === "session.status_rescheduled")).toHaveLength(1);
    expect(idles(seen)).toEqual([{ type: "end_turn" }]);
  }, 30_000);

  it("uses the whole retry budget, then ends retries_exhausted", async () => {
    const id = await createSession("always-fail");
    runs = 0;
    await send(id, go);
    const seen = await until(id, (e) => e.some((x) => x.type === "session.status_idle"));
    expect(runs).toBe(3);
    expect(retryStatuses(seen)).toEqual(["retrying", "retrying", "exhausted"]);
    expect(idles(seen)).toEqual([{ type: "retries_exhausted" }]);
  }, 30_000);

  it("terminates the session on an authentication failure without retrying", async () => {
    const id = await createSession("auth-fail");
    runs = 0;
    await send(id, go);
    const seen = await until(id, (e) => e.some((x) => x.type === "session.status_terminated"));
    expect(runs).toBe(1);
    expect(retryStatuses(seen)).toEqual(["terminal"]);
    expect(idles(seen)).toEqual([]);
  }, 30_000);

  it("re-announces the remaining call on a partial answer and ignores a late one", async () => {
    const id = await createSession("park-two");
    runs = 0;
    await send(id, go);
    await until(id, (e) => idles(e).length === 1);
    expect(idles(await events(id))).toEqual([{ type: "requires_action", event_ids: ["sevt_call_a", "sevt_call_b"] }]);
    await send(id, answer("sevt_call_a"));
    await until(id, (e) => idles(e).length === 2);
    expect(idles(await events(id)).at(-1)).toEqual({ type: "requires_action", event_ids: ["sevt_call_b"] });
    expect(runs).toBe(1);
    await send(id, answer("sevt_call_b"));
    await until(id, (e) => idles(e).length === 3);
    expect(idles(await events(id)).at(-1)).toEqual({ type: "end_turn" });
    expect(runs).toBe(2);
    await send(id, answer("sevt_call_a"));
    await new Promise((r) => setTimeout(r, 500));
    expect(idles(await events(id))).toHaveLength(3);
    expect(runs).toBe(2);
  }, 45_000);

  it("does not re-run a turn that failed after producing agent events", async () => {
    const id = await createSession("crash-after-agent-event");
    runs = 0;
    await post(`/v1/oma/sessions/${id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }] });
    let seen: any[] = [];
    for (let t = 0; t < 12_000 && !seen.some((e) => e.type === "session.status_idle"); t += 200) {
      await new Promise((r) => setTimeout(r, 200));
      seen = await events(id);
    }
    expect(runs).toBe(1);
    expect(seen.filter((e) => e.type === "session.status_idle").map((e) => e.stop_reason.type)).toEqual(["retries_exhausted"]);
  }, 30_000);
});
