// @ts-nocheck
// SessionDO's interrupt handling and lane drain, driven through the public API
// and the DO event log, before they move behind Ports.
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

async function createSession(harness: string) {
  const a = await post("/v1/oma/agents", { name: `host-${crypto.randomUUID()}`, model: "claude-sonnet-4-6", _oma: { harness } });
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

describe("characterization: SessionDO interrupt and lane drain", () => {
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
