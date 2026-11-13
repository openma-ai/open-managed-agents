// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

it("persists an idle terminal when required persistence fails before harness construction", async () => {
  const request = async (path, body) => {
    const response = await exports.default.fetch(new Request(`http://localhost/v1${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const value = await response.json(); expect(response.ok, JSON.stringify(value)).toBe(true); return value;
  };
  const agent = await request("/agents", { name: "preflight-terminal", model: "unused-preflight-model", system: "No inference should start", tools: [] });
  const environment = await request("/environments", { name: "preflight-terminal", config: { type: "cloud" } });
  const session = await request("/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: environment.id });
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
  const names = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const saved = await runInDurableObject(stub, instance => {
    const values = names.map(name => instance.env[name]);
    for (const name of names) delete instance.env[name];
    return values;
  });
  try {
    await request(`/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "preflight" }] }] });
    await expect.poll(async () => (await request(`/sessions/${session.id}/events`)).data.some(e => e.type === "session.error"), { timeout: 15000 }).toBe(true);
    const events = (await request(`/sessions/${session.id}/events`)).data;
    expect(JSON.stringify(events)).toContain("Managed outputs persistence requires");
    await expect.poll(async () => (await request(`/sessions/${session.id}/events`)).data.filter(e => e.type === "session.status_idle"), { timeout: 3000 }).toEqual([expect.objectContaining({ stop_reason: { type: "retries_exhausted" } })]);
    expect(events.some(e => e.type.startsWith("agent.") || e.type === "span.model_request_start")).toBe(false);
    expect((await request(`/sessions/${session.id}`)).status).toBe("idle");
    const execution = () => env.MAIN_DB.prepare("SELECT id,state,attempt_id,generation,attempt_count FROM managed_session_executions WHERE session_id=?").bind(session.id).first();
    await expect.poll(async () => (await execution())?.state).toBe("failed");
    const settled = await execution();
    expect(settled.attempt_count).toBe(1);
    console.log(JSON.stringify({ op: "preflight_terminal_gate", session_id: session.id, execution: settled,
      terminal: "retries_exhausted", model_or_tool_events: 0 }));
  } finally {
    await runInDurableObject(stub, async (instance, state) => {
      for (let i=0;i<names.length;i++) { if (saved[i] === undefined) delete instance.env[names[i]]; else instance.env[names[i]]=saved[i]; }
      await instance._recoveryPromise; await instance._recoveryRun; await instance._finalizePromise;
      await Promise.all(instance._maintenanceRuns.values()); await state.storage.deleteAlarm();
    });
  }
});
