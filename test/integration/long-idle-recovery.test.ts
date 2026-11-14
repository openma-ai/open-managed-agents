// Reset simulation, not a wall-clock long-running certification.
// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import { SqliteHistory } from "../../apps/agent/src/runtime/sqlite-history";
import { ensureModelCards } from "./_model-cards";

const headers = { "x-api-key": "test-key", "content-type": "application/json" };
async function api(path, body) {
  const response = await exports.default.fetch(new Request("http://localhost" + path, {
    headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  }));
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json();
}
const stubOf = id => env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", id])));
beforeAll(async () => {
  await ensureModelCards(["claude-sonnet-4-6"]);
  registerHarness("long-idle-echo", () => ({ async run(ctx) {
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "AFTER_IDLE_OK" }] });
  } }));
});
async function fixture() {
  const agent = await api("/v1/oma/agents", { name: "long-idle", model: "claude-sonnet-4-6", _oma: { harness: "long-idle-echo" } });
  const environment = await api("/v1/environments", { name: "long-idle", config: { type: "cloud" } });
  const session = await api("/v1/sessions", { agent: agent.id, environment_id: environment.id });
  const stub = stubOf(session.id);
  await runInDurableObject(stub, instance => instance._sandboxWarm);
  const f = { session, agent, environment, stub };
  await followup(f); // A genuinely completed turn precedes the idle gap.
  return f;
}
async function plantDeadTurn(f, ageMs, tool = false) {
  const now = Date.now();
  // The runtime marker table remains an active Port. Only inject the lost
  // owner's marker; migrations and managed Session creation stay real.
  await env.MAIN_DB.prepare(
    "INSERT INTO sessions (id,tenant_id,agent_id,environment_id,title,status,created_at,updated_at,turn_id,turn_started_at) VALUES (?,?,?,?,?,'running',?,?,?,?)",
  ).bind(f.session.id, "default", f.agent.id, f.environment.id, "", now - ageMs, now - ageMs, "turn_dead", now - ageMs).run();
  await env.MAIN_DB.prepare("UPDATE managed_sessions SET status='running' WHERE workspace_id='default' AND id=?").bind(f.session.id).run();
  await runInDurableObject(f.stub, async (instance, state) => {
    instance._coldStartFlushDone = false;
    instance._instanceStartedAt = Date.now();
    expect(instance.onFiberRecovered).toBeUndefined();
    const history = new SqliteHistory(state.storage.sql, null);
    history.append({ id: "lost_running", type: "session.status_running", processed_at: new Date(now - ageMs).toISOString() });
    if (tool) history.append({ type: "agent.tool_use", id: "tu_long_idle", name: "bash", input: { command: "sleep 1000" } });
  });
}
async function alarm(f) {
  await runInDurableObject(f.stub, async (_instance, state) => state.storage.setAlarm(Date.now() - 1000));
  // No HTTP/event/stream request triggers recovery: only the persisted alarm.
  await runDurableObjectAlarm(f.stub);
  await runInDurableObject(f.stub, async instance => {
    // Short alarm dispatch intentionally returns before detached recovery.
    // Join its observed work, not another recovery trigger or HTTP poll.
    await instance._recoveryRun;
    await instance._finalizePromise;
    await instance._managedProjectionChain;
  });
}
async function marker(id) {
  return env.MAIN_DB.prepare("SELECT status,turn_id,turn_started_at FROM sessions WHERE id=?").bind(id).first();
}
async function followup(f) {
  const before = (await api("/v1/sessions/" + f.session.id + "/events?limit=100")).data.length;
  await api("/v1/sessions/" + f.session.id + "/events", { events: [{ type: "user.message", content: [{ type: "text", text: "continue after idle" }] }] });
  await expect.poll(async () => JSON.stringify((await api("/v1/sessions/" + f.session.id + "/events?limit=100")).data.slice(before)), { timeout: 10000 }).toContain("AFTER_IDLE_OK");
  await expect.poll(async () => (await api("/v1/sessions/" + f.session.id)).status).toBe("idle");
}

describe("Long-idle managed Session recovery", () => {
  it("keeps a clean idle Session idle without false recovery and accepts a followup", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, instance => { instance._coldStartFlushDone = false; });
    await alarm(f);
    expect((await api("/v1/sessions/" + f.session.id)).status).toBe("idle");
    const events = await api("/v1/sessions/" + f.session.id + "/events?limit=100");
    expect(events.data.filter(e => e.type === "session.status_rescheduled" || e.type === "session.error")).toEqual([]);
    await followup(f);
  });
  it.each([30 * 60 * 1000, 24 * 60 * 60 * 1000])("recovers a %ims old orphan via alarm and accepts a followup", async ageMs => {
    const f = await fixture();
    await plantDeadTurn(f, ageMs);
    expect(await marker(f.session.id)).toMatchObject({ status: "running", turn_id: "turn_dead" });
    await alarm(f);
    expect(await marker(f.session.id)).toEqual({ status: "idle", turn_id: null, turn_started_at: null });
    expect((await api("/v1/sessions/" + f.session.id)).status).toBe("idle");
    await followup(f);
  });
  it("closes a lost tool with one error result, clears the marker, and accepts a followup", async () => {
    const f = await fixture();
    await plantDeadTurn(f, 30 * 60 * 1000, true);
    await alarm(f);
    expect(await marker(f.session.id)).toEqual({ status: "idle", turn_id: null, turn_started_at: null });
    await runInDurableObject(f.stub, (_instance, state) => {
      const history = new SqliteHistory(state.storage.sql, null);
      const paired = history.getEvents().filter(e => e.type === "agent.tool_result" && e.tool_use_id === "tu_long_idle");
      expect(paired).toHaveLength(1);
      expect(paired[0].is_error).toBe(true);
      expect(JSON.stringify(history.getMessages())).toContain("tu_long_idle");
    });
    expect((await api("/v1/sessions/" + f.session.id)).status).toBe("idle");
    await followup(f);
  });
});
