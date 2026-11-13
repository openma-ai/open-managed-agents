import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { SandboxGoneError } from "@open-managed-agents/sandbox";
import { providerFailureModel } from "../../packages/agent-harness/test/provider-failure-model";
import { PiHarness } from "../../packages/agent-harness/src/pi-loop";
import { registerHarness } from "../../packages/agent-harness/src/registry";
import type { HarnessContext } from "../../packages/agent-harness/src/interface";
import { ensureModelCards } from "./_model-cards";

beforeAll(() => ensureModelCards(["provider-failure-model"]));
// Real Workerd Session/Work/D1 and PortsSessionSandbox ownership. Only the
// provider executor is faulted; the successful filesystem capability writes
// actual test R2 bytes. This is not a Cloudflare container SDK/live-provider test.
it.each([["gone",false],["transport",false],["gone",true],["transport",true],["lease",false]] as const)("provider %s returns a correlated error (mixed custom: %s)", async (failure,mixed) => {
  const model = providerFailureModel(mixed);
  const { faux, models } = model;
  const harness = `provider-failure-${crypto.randomUUID()}`;
  registerHarness(harness, () => ({ async run(ctx: HarnessContext) {
    await new PiHarness().run({ ...ctx, pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" } });
  } }));
  const request = async (path: string, body?: unknown) => {
    const response = await exports.default.fetch(new Request("http://localhost" + path, {
      method: body === undefined ? "GET" : "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true); return result;
  };
  const agent = await request("/v1/agents", { name: harness, model: "provider-failure-model", _oma: { harness }, tools: [{ type: "agent_toolset_20260401" },{type:"custom",name:"approve_ticket",description:"approval",input_schema:{type:"object",properties:{ticket:{type:"string"}},required:["ticket"]}}] });
  const environment = await request("/v1/environments", { name: harness, config: { type: "cloud" } });
  const session = await request("/v1/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: environment.id });
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
  const objectKey = `provider-failure-fixture/${session.id}`;
  let faults = 0; let writes = 0;
  await runInDurableObject(stub, async (instance: any) => {
    await instance._sandboxWarm; instance.ensureSandboxCreated();
    const state = instance.portsSandbox.state;
    const original = state.options.executor;
    if (failure === "lease") {
      const { ports } = await state.compose();
      const keepAlive = ports.sandbox.keepAlive.bind(ports.sandbox);
      state.options.keepAliveMs = 0; // Drive the real exec-boundary renewal, no clock jump.
      ports.sandbox.keepAlive = async (...args: any[]) => {
        const called = instance.openHistory().getEvents().some((event: any) => event.type === "agent.tool_use" && event.id === "failed-read");
        if (called && faults === 0) {
          faults++;
          console.log(JSON.stringify({op:"provider.lease.gone",session_id:session.id,call_id:"failed-read",execution:state.execution()}));
          return "gone";
        }
        return keepAlive(...args);
      };
    }
    const wrap = (target: any) => new Proxy(target, { get(target, key) {
      if (key === "readFile") return async (path: string) => {
        console.log(JSON.stringify({op:"provider.read",path}));
        if (path.endsWith("/failure-probe")) {
          if (failure === "lease") throw new Error("lease-loss call must stop before provider dispatch");
          faults++;
          console.log(JSON.stringify({ op: "provider.failure", session_id: session.id, failure, call_id: "failed-read" }));
          if (failure === "gone") throw new SandboxGoneError("provider reclaimed before dispatch");
          throw new Error("provider transport unavailable before dispatch");
        }
        return target.readFile(path);
      };
      if (key === "writeFile") return async (path: string, content: string) => {
        console.log(JSON.stringify({op:"provider.write",path}));
        if (path.endsWith("/continued-action")) { writes++; await env.FILES_BUCKET.put(objectKey, content); return; }
        return target.writeFile(path, content);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    state.options.executor = (...args: any[]) => wrap(original(...args));
    if (state.current) state.current.executor = wrap(state.current.executor);
  });
  const history = async () => (await request(`/v1/sessions/${session.id}/events?limit=1000`)).data as any[];
  try {
    await request(`/v1/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "test" }] }] });
    const outstanding = async () => (await env.MAIN_DB.prepare("SELECT COUNT(*) AS n FROM managed_session_executions WHERE session_id=? AND state IN ('queued','running')").bind(session.id).first<{n:number}>())?.n;
    if (mixed) {
      await expect.poll(async () => (await history()).some(e=>e.type === "session.status_idle" && e.stop_reason.type === "requires_action"), {timeout:15_000}).toBe(true);
      await expect.poll(outstanding,{timeout:15_000}).toBe(0);
      const parked = await history();
      expect(parked.findIndex(e=>e.type === "agent.tool_result" && e.tool_use_id === "failed-read")).toBeLessThan(parked.findIndex(e=>e.type === "session.status_idle"));
      const answer = (id:string) => request(`/v1/sessions/${session.id}/events`,{events:[{type:"user.custom_tool_result",custom_tool_use_id:id,content:[{type:"text",text:"approved"}]}]});
      await answer("c1"); await expect.poll(outstanding,{timeout:15_000}).toBe(0); expect(faux.state.callCount).toBe(1);
      await answer("c1"); await expect.poll(outstanding,{timeout:15_000}).toBe(0); expect(faux.state.callCount).toBe(1);
      await answer("c2");
    }
    await expect.poll(async () => (await history()).some(e=>e.type === "session.status_idle" && e.stop_reason.type === "end_turn"), {timeout:15_000}).toBe(true);
    await expect.poll(outstanding,{timeout:15_000}).toBe(0);
    const executions = (await env.MAIN_DB.prepare("SELECT state,attempt_count FROM managed_session_executions WHERE session_id=?").bind(session.id).all()).results;
    for (const execution of executions) expect(execution).toMatchObject({state:"completed",attempt_count:1});
    const events = await history();
    console.log(JSON.stringify({ op: "provider.failure.timeline", failure, session_id: session.id, model_calls: faux.state.callCount, events, work: await env.MAIN_DB.prepare("SELECT state,attempt_count,failure FROM managed_session_executions WHERE session_id=?").bind(session.id).all() }));
    const failed = events.filter(e => e.type === "agent.tool_result" && e.tool_use_id === "failed-read");
    expect(failed).toHaveLength(1); expect(failed[0].is_error).toBe(true);
    expect(JSON.parse(model.observed()).filter((message: any) => message.role === "toolResult" && message.toolCallId === "failed-read")).toEqual([expect.objectContaining({isError:true})]);
    const success = events.filter(e => e.type === "agent.tool_result" && e.tool_use_id === "continued-write");
    expect(success).toHaveLength(1); expect(success[0].is_error).not.toBe(true);
    expect(await (await env.FILES_BUCKET.get(objectKey))?.text()).toBe("continued bytes");
    expect(faux.state.callCount).toBe(3); expect(faults).toBe(1); expect(writes).toBe(1);
    expect(events.slice(0, events.indexOf(success[0])).filter(e => e.type === "session.status_idle" && e.stop_reason.type !== "requires_action")).toEqual([]);
    expect(events.filter(e => e.type === "session.error")).toEqual([]);
    expect(events.filter(e => e.type === "session.status_idle").map(e => e.stop_reason.type).filter(reason=>reason !== "requires_action")).toEqual(["end_turn"]);
  } finally {
    console.log(JSON.stringify({op:"provider.fixture.final",failure,mixed,session_id:session.id,model_calls:faux.state.callCount,
      events:await history(),work:await env.MAIN_DB.prepare("SELECT id,state,attempt_count,generation,failure FROM managed_session_executions WHERE session_id=?").bind(session.id).all()}));
    await env.FILES_BUCKET.delete(objectKey);
  }
}, 60_000);
