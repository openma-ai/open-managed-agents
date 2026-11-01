// @ts-nocheck
// Official CMA state machine on the CF SessionDO (PR #399, owner t307u/t308u).
// Sources: anthropics/skills managed-agents-core/events; SDK events.d.ts
// (retry_status retrying/exhausted/terminal, stop_reason retries_exhausted).
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { ensureModelCards } from "./_model-cards";
import { registerTestHarnesses } from "../harnesses";
import { SqliteHistory } from "../../apps/agent/src/runtime/history";

beforeAll(() => ensureModelCards(["claude-sonnet-4-6"]));
registerTestHarnesses();

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
const api = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));
const post = (path: string, body: any) =>
  api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
const stubOf = (id: string) => env.SESSION_DO.get(env.SESSION_DO.idFromName(id));

async function createSession(harness: string) {
  const a = await post("/v1/oma/agents", { name: `cma-${Date.now()}`, model: "claude-sonnet-4-6", _oma: { harness } });
  const e = await post("/v1/oma/environments", { name: `env-${Date.now()}`, config: { type: "cloud" } });
  const s = await post("/v1/oma/sessions", {
    agent: ((await a.json()) as any).id,
    environment_id: ((await e.json()) as any).id,
  });
  return ((await s.json()) as any).id as string;
}

async function domEvents(sessionId: string): Promise<any[]> {
  return runInDurableObject(stubOf(sessionId), async (_i, state) =>
    new SqliteHistory(state.storage.sql, null).getEvents() as any[]);
}

async function waitFor(sessionId: string, pred: (ev: any[]) => boolean, ms = 9000) {
  for (let t = 0; t < ms; t += 200) {
    const ev = await domEvents(sessionId);
    if (pred(ev)) return ev;
    await new Promise((r) => setTimeout(r, 200));
  }
  return domEvents(sessionId);
}

const lifecycle = (ev: any[]) =>
  ev.filter((e) => e.type === "session.error" || e.type.startsWith("session.status_"))
    .map((e) => e.type === "session.error" ? `error:${e.error?.retry_status}`
      : e.type === "session.status_idle" ? `idle:${e.stop_reason?.type}` : e.type.replace("session.status_", ""));

describe("CF SessionDO CMA retry / exhausted wire", () => {
  it("retrying emits error{retrying} before rescheduled; exhausted emits error{exhausted} + idle retries_exhausted with no trailing rescheduled", async () => {
    const sessionId = await createSession("crash-sh");
    await post(`/v1/oma/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "crash" }] }],
    });
    // Mid-run input during the retry window: held, not run alone, not deleted.
    await waitFor(sessionId, (e) => e.some((x) => x.type === "session.status_rescheduled"));
    const mid = await post(`/v1/oma/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "mid-run" }] }],
    });
    expect(mid.status).toBeLessThan(300);
    let ev = await waitFor(sessionId, (e) => e.some((x) => x.type === "session.status_idle"));
    await new Promise((r) => setTimeout(r, 1500));
    ev = await domEvents(sessionId);
    const seq = lifecycle(ev);
    const firstRetry = seq.indexOf("error:retrying");
    expect(firstRetry).toBeGreaterThanOrEqual(0);
    expect(seq[firstRetry + 1]).toBe("rescheduled");
    // every rescheduled is preceded by error{retrying}
    seq.forEach((s, i) => { if (s === "rescheduled") expect(seq[i - 1]).toBe("error:retrying"); });
    const exhausted = seq.lastIndexOf("error:exhausted");
    expect(exhausted).toBeGreaterThan(firstRetry);
    expect(seq.slice(exhausted)).toEqual(["error:exhausted", "idle:retries_exhausted"]);
    expect(seq).not.toContain("error:terminal");
    expect(seq).not.toContain("idle:end_turn");
    // Owner lock (holdQueuedOnLane): the mid-run row is retained unprocessed
    // and does not start a new turn by itself after exhausted.
    const idleAt = ev.findIndex((e) => e.type === "session.status_idle");
    expect(ev.slice(idleAt + 1).some((e) => e.type === "session.status_running")).toBe(false);
    const midRows = ev.filter((e) => e.type === "user.message" && e.content?.[0]?.text === "mid-run");
    expect(midRows.every((e) => !e.processed_at)).toBe(true);
  });

  it("interrupt against an idle retries_exhausted session is a no-op", async () => {
    const sessionId = `cma_int_idle_${crypto.randomUUID()}`;
    await runInDurableObject(stubOf(sessionId), async (instance, state) => {
      const room = instance as any;
      room._ensureCfAgentsSchema(); room.ensureSchema(); room._coldStartFlushDone = true;
      room.setState({ ...room.state, session_id: sessionId, tenant_id: "workspace", agent_id: "a" });
      room._ensurePrimaryThread();
      const history = new SqliteHistory(state.storage.sql, null);
      history.append({ type: "user.message", content: [{ type: "text", text: "go" }], processed_at: new Date().toISOString() } as never);
      history.append({ type: "session.status_running" } as never);
      history.append({ type: "session.error", error: { type: "unknown_error", message: "x", retry_status: "exhausted" } } as never);
      history.append({ type: "session.status_idle", stop_reason: { type: "retries_exhausted" } } as never);
      const res = await room.fetch(new Request("http://internal/event", { method: "POST", body: JSON.stringify({ type: "user.interrupt" }) }));
      expect(res.status).toBe(202);
      const after = history.getEvents() as any[];
      const statuses = after.filter((e) => e.type.startsWith("session.status_"));
      expect(statuses.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "retries_exhausted" } });
      expect(after.filter((e) => e.type === "session.status_idle")).toHaveLength(1);
    });
  });

  it("user.message while idle requires_action is a 400; settle events still accepted", async () => {
    const sessionId = `cma_ra_400_${crypto.randomUUID()}`;
    await runInDurableObject(stubOf(sessionId), async (instance, state) => {
      const room = instance as any;
      room._ensureCfAgentsSchema(); room.ensureSchema(); room._coldStartFlushDone = true;
      room.setState({ ...room.state, session_id: sessionId, tenant_id: "workspace", agent_id: "a",
        pending_tool_calls: [{ toolCallId: "ctu_1", toolName: "run_tests", args: {} }] });
      room._ensurePrimaryThread();
      const history = new SqliteHistory(state.storage.sql, null);
      history.append({ type: "user.message", content: [{ type: "text", text: "go" }], processed_at: new Date().toISOString() } as never);
      history.append({ type: "agent.custom_tool_use", id: "ctu_1", name: "run_tests", input: {} } as never);
      history.append({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["ctu_1"] } } as never);
      const before = (history.getEvents() as any[]).length;
      const res = await room.fetch(new Request("http://internal/event", {
        method: "POST", body: JSON.stringify({ type: "user.message", content: [{ type: "text", text: "hi" }] }),
      }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
      expect((history.getEvents() as any[]).length).toBe(before);
    });
  });
});

describe("CF POST /events: [user.interrupt, user.message] during requires_action", () => {
  // managed-agents-events.md: "Against an already-idle session an interrupt is
  // normally a no-op"; while requires_action "only settle events are accepted -
  // a user.message there is a 400". The batch is rejected whole: nothing lands.
  it("rejects the whole batch and appends nothing", async () => {
    const sessionId = await createSession("crash-sh");
    await runInDurableObject(stubOf(sessionId), async (instance, state) => {
      const room = instance as any;
      room.setState({ ...room.state, pending_tool_calls: [{ toolCallId: "ctu_b", toolName: "run_tests", args: {} }] });
      const history = new SqliteHistory(state.storage.sql, null);
      history.append({ type: "agent.custom_tool_use", id: "ctu_b", name: "run_tests", input: {} } as never);
      history.append({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["ctu_b"] } } as never);
    });
    const before = (await domEvents(sessionId)).length;
    const res = await post(`/v1/oma/sessions/${sessionId}/events`, { events: [
      { type: "user.interrupt" },
      { type: "user.message", content: [{ type: "text", text: "next" }] },
    ] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    const after = await domEvents(sessionId);
    expect(after.length).toBe(before);
    expect(after.some((e) => e.type === "user.interrupt")).toBe(false);
  });
});

describe("CF SessionDO exhausted hold survives DO eviction", () => {
  it("pre-exhausted local pending row is admitted held after state reload, not run alone", async () => {
    const sessionId = await createSession("crash-sh");
    const lane = "sthr_primary";
    const evId = `sevt_pre_${crypto.randomUUID()}`;
    await runInDurableObject(stubOf(sessionId), async (instance) => {
      const room = instance as any;
      room.enqueuePendingIfNew({ type: "user.message", id: evId, content: [{ type: "text", text: "pre" }] });
      room.setExhaustedAt(lane, Date.now() + 1);
    });
    await runInDurableObject(stubOf(sessionId), async (instance, state) => {
      const room = instance as any;
      // Simulate eviction: drop in-memory state and reload from DO SQLite.
      room._state = undefined;
      room._loadStateFromSql();
      expect(room.state.exhausted_at_by_lane?.[lane]).toBeTypeOf("number");
      const store = await room.getExecutionStore();
      expect(await room.admitPendingFallback(store, lane)).toBe(false);
      const row = await store.find({ workspaceId: room.state.tenant_id, executionId: evId });
      expect(row?.state).toBe("queued");
      expect(row?.heldAfterExhaustedAt).toBeTruthy();
      const history = new SqliteHistory(state.storage.sql, null);
      expect((history.getEvents() as any[]).some((e) => e.type === "session.status_running")).toBe(false);
    });
  });
});
