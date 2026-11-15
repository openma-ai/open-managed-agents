import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { ensureModelCards } from "./_model-cards";
import { registerTestHarnesses } from "../harnesses";
registerTestHarnesses();
beforeAll(() => ensureModelCards(["claude-sonnet-4-6"]));
const headers = { "x-api-key": "test-key", "content-type": "application/json" };
const post = async (path: string, body: unknown) => {
  const response = await exports.default.fetch(new Request("http://localhost" + path, { method: "POST", headers, body: JSON.stringify(body) }));
  expect(response.ok).toBe(true);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};
it.each([false, true])("idle does not wait for publication or rewrite completed outcome on upload failure (reject: %s)", async reject => {
  const agent = await post("/v1/oma/agents", { name: "output-barrier", model: "claude-sonnet-4-6", _oma: { harness: "multi-msg" } });
  const environment = await post("/v1/oma/environments", { name: "output-barrier", config: { type: "cloud" } });
  const session = await post("/v1/oma/sessions", { agent: agent.id, environment_id: environment.id });
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(session.id));
  await runInDurableObject(stub, async (instance: any) => {
    await instance._sandboxWarm;
    instance.ensureSandboxCreated();
    const end = instance.portsSandbox.endExecution.bind(instance.portsSandbox);
    instance.outputBarrierEntered = false;
    instance.outputBarrier = new Promise<void>(resolve => { instance.releaseOutputBarrier = resolve; });
    instance.portsSandbox.endExecution = async () => {
      instance.outputBarrierEntered = true;
      await instance.outputBarrier;
      if (reject) throw new Error("output publication failed");
      await end();
    };
  });
  const events = async () => {
    const response = await stub.fetch(new Request("http://internal/events?limit=1000"));
    return (await response.json() as { data: Array<{ type: string; data: { source?: string; stop_reason?: { type: string } } }> }).data;
  };
  try {
    await post(`/v1/oma/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] });
    await expect.poll(() => runInDurableObject(stub, (instance: any) => instance.outputBarrierEntered)).toBe(true);
    await expect.poll(async () => (await events()).some(e => e.type === "session.status_idle")).toBe(true);
  } finally {
    await runInDurableObject(stub, (instance: any) => { instance.releaseOutputBarrier(); });
    await expect.poll(async () => (await events()).some(e => e.type === "session.status_idle")).toBe(true);
    await expect.poll(async () => (await env.MAIN_DB.prepare("SELECT state FROM managed_session_executions WHERE session_id=?").bind(session.id).first<{state:string}>())?.state).toBe("completed");
    if (reject) {
      await expect.poll(async () => (await events()).filter(e => e.type === "session.warning" && e.data.source === "sandbox.persistence").map(e => e.data))
        .toEqual([expect.objectContaining({ source: "sandbox.persistence", message: expect.stringContaining("output publication failed") })]);
    }
    expect((await events()).filter(e => e.type === "session.status_idle").map(e => e.data.stop_reason?.type))
      .toEqual(["end_turn"]);
  }
});
