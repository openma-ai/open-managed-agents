import { expect, it } from "vitest";
import type { AcpRuntime, AcpSession } from "@open-managed-agents/acp-runtime";
import * as composition from "../src/node-work-composition.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const signal = new AbortController().signal;
const context = { command: { sessionId: "s", turnId: "t" }, signal, async flush() {} } as never;
function fixture(events: unknown[]) {
  const activity = new composition.WorkTurnActivities();
  let options: any;
  const runtime = activity.wrapRuntime({ async start(input) { options = input; return {
    options: input, agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.94.0" }, async *prompt() { yield* events; }, async steer() { return "injected"; },
    isAlive() { return true; },
  } as unknown as AcpSession; } } satisfies AcpRuntime);
  return { activity, runtime, options: () => options };
}
it("awaits actual registered child completion after prompt RPC completion and seals admission until publication", async () => {
  const f = fixture([{ type: "promptComplete", response: { stopReason: "end_turn" } }]);
  f.activity.admit("t"); const child = deferred(); let drained = false;
  f.activity.register("t", "child", child.promise);
  const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  const draining = f.activity.drain(context).then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  expect(() => f.activity.register("t", "late", Promise.resolve())).toThrow(/closed/);
  child.resolve(); await draining; expect(drained).toBe(true);
  expect(() => f.activity.admit("next")).toThrow();
  f.activity.published("t"); f.activity.admit("next");
});
it.each([
  [[{ sessionUpdate: "tool_call", toolCallId: "tool", status: "in_progress" }]],
  [[{ sessionUpdate: "tool_call", toolCallId: "tool", status: "completed", rawInput: { run_in_background: true } }]],
  [[]],
])("does not certify unknown tools or a missing prompt completion as drained (%j)", async events => {
  const f = fixture(events.length ? [...events, { type: "promptComplete", response: { stopReason: "end_turn" } }] : []);
  f.activity.admit("t"); const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).rejects.toThrow(/unproven|completion/i);
});
it("joins real client callback execution even after prompt completion", async () => {
  const f = fixture([{ type: "promptComplete", response: { stopReason: "end_turn" } }]);
  const pending = deferred(); f.activity.admit("t");
  const session = await f.runtime.start({ agent: { command: "fixture" }, clientCallbacks: { async writeTextFile() { await pending.promise; return {}; } } });
  const writing = f.options().clientCallbacks.writeTextFile({});
  for await (const _ of session.prompt("hi")) {}
  let drained = false; const draining = f.activity.drain(context).then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); pending.resolve(); await writing; await draining;
  expect(drained).toBe(true);
});
it("refuses a failed actual activity and cancels local drain wait without fabricating completion", async () => {
  const f = fixture([{ type: "promptComplete", response: { stopReason: "end_turn" } }]);
  f.activity.admit("t"); f.activity.register("t", "failed", Promise.reject(Error("child failed")));
  const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).rejects.toThrow("child failed");
});
it("default capability loading rejects published common 0.13.1 before constructing a process", async () => {
  await expect(composition.loadWorkRuntimeModules()).rejects.toThrow(/0\.13\.1.*ManagedHarnessFinalizationError/);
});
it("aborting a join does not turn a still-running child into a completion receipt", async () => {
  const f = fixture([{ type: "promptComplete", response: { stopReason: "end_turn" } }]);
  const child = deferred(), controller = new AbortController(); f.activity.admit("t");
  f.activity.register("t", "child", child.promise);
  const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  const drain = f.activity.drain({ ...(context as object), signal: controller.signal } as never);
  controller.abort(Error("claim lost")); await expect(drain).rejects.toThrow("claim lost");
  expect(() => f.activity.published("t")).toThrow(/drain/);
  child.resolve();
});
it("rejects late out-of-band activity during the actual join", async () => {
  const f = fixture([{ type: "promptComplete", response: { stopReason: "end_turn" } }]);
  const child = deferred(); f.activity.admit("t"); f.activity.register("t", "child", child.promise);
  const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  const drain = f.activity.drain(context);
  f.options().onOutOfBandSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "late", status: "completed" });
  child.resolve(); await expect(drain).rejects.toThrow(/after admission closed/);
});
it("joins an opaque tool only through an actual host-owned completion promise", async () => {
  const f = fixture([{ sessionUpdate: "tool_call", toolCallId: "child", status: "completed", rawInput: { run_in_background: true } }, { type: "promptComplete", response: { stopReason: "end_turn" } }]);
  const child = deferred(); f.activity.admit("t"); f.activity.register("t", "tool:child", child.promise);
  const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  let done = false; const drain = f.activity.drain(context).then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); child.resolve(); await drain; expect(done).toBe(true);
});
it("rejects a detached steer result instead of counting a completed prior prompt as quiescence", async () => {
  const activity = new composition.WorkTurnActivities(); activity.admit("t");
  const runtime = activity.wrapRuntime({ async start(options) { return { options,
    async *prompt() { yield { type: "promptComplete", response: {} }; },
    async steer() { return "startedNewTurn"; },
  } as unknown as AcpSession; } });
  const session = await runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(session.steer("next")).rejects.toThrow(/unproven/i);
  await expect(activity.drain(context)).rejects.toThrow(/unproven/i);
});
it("does not mistake a terminal handle or extension callback result for joined background effects", async () => {
  const f = fixture([{ type: "promptComplete", response: {} }]); f.activity.admit("t");
  const session = await f.runtime.start({ agent: { command: "fixture" }, clientCallbacks: {
    async extensionRequest() { return { taskId: "still-running" }; },
  } });
  await f.options().clientCallbacks.extensionRequest("spawn", {});
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).rejects.toThrow(/unproven/);
});
it("a failed prompt cannot be converted to a drain receipt by a later successful prompt", async () => {
  const activity = new composition.WorkTurnActivities(); activity.admit("t"); let calls = 0;
  const runtime = activity.wrapRuntime({ async start(options) { return { options,
    async *prompt() { if (++calls === 1) throw Error("lost transport"); yield { type: "promptComplete", response: {} }; },
  } as unknown as AcpSession; } });
  const session = await runtime.start({ agent: { command: "fixture" } });
  await expect((async () => { for await (const _ of session.prompt("bad")) {} })()).rejects.toThrow("lost transport");
  for await (const _ of session.prompt("retry")) {}
  await expect(activity.drain(context)).rejects.toThrow(/completion/);
});

it.each(["completed", "failed"])("accepts pinned native synchronous tool %s followed by prompt completion without host registration", async status => {
  const f = fixture([{ sessionUpdate: "tool_call", toolCallId: "read", kind: "read", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "read", status }, { type: "promptComplete", response: { stopReason: "end_turn" } }]);
  f.activity.admit("t"); const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).resolves.toBeUndefined();
});
it.each([true, false])("requires terminal exit evidence for native execution (exit=%s)", async exited => {
  const f = fixture([{ sessionUpdate: "tool_call", toolCallId: "bash", kind: "execute", status: "in_progress", rawInput: { command: "work" } },
    { sessionUpdate: "tool_call_update", toolCallId: "bash", status: "completed", ...(exited ? { _meta: { terminal_exit: { exit_code: 0, signal: null, terminal_id: "bash" } } } : {}) },
    { type: "promptComplete", response: { stopReason: "end_turn" } }]);
  f.activity.admit("t"); const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  if(exited) await expect(f.activity.drain(context)).resolves.toBeUndefined();
  else await expect(f.activity.drain(context)).rejects.toThrow(/unproven/);
});
it("retains a background marker across completed delta and later terminal exit", async () => {
  const f = fixture([{ sessionUpdate: "tool_call", toolCallId: "bash", kind: "execute", status: "in_progress", rawInput: { run_in_background: true } },
    { sessionUpdate: "tool_call_update", toolCallId: "bash", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } },
    { type: "promptComplete", response: { stopReason: "end_turn" } }]);
  f.activity.admit("t"); const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).rejects.toThrow(/unproven/);
});
it("does not infer native child completion from completed spawn tool", async () => {
  const f = fixture([{ sessionUpdate: "tool_call", toolCallId: "spawn", kind: "other", status: "completed", _meta: { codex: { collaboration: { tool: "spawnAgent", receiverThreadIds: ["child"] } } } },
    { type: "promptComplete", response: {} }]);
  f.activity.admit("t"); const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).rejects.toThrow(/unproven/);
});
it("accepts native child completion from an awaited wait result, not spawn completion", async () => {
  const f = fixture([{ sessionUpdate: "tool_call", toolCallId: "spawn", kind: "other", status: "completed", _meta: { codex: { collaboration: { tool: "spawnAgent", receiverThreadIds: ["child"] } } } },
    { sessionUpdate: "tool_call", toolCallId: "wait", kind: "other", status: "completed", rawInput: { agentsStates: { child: { status: "completed" } } }, _meta: { codex: { collaboration: { tool: "wait", receiverThreadIds: ["child"] } } } },
    { type: "promptComplete", response: {} }]);
  f.activity.admit("t"); const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).resolves.toBeUndefined();
});
it("rejects Claude async Agent markers even when tool result and prompt both completed", async () => {
  const f = fixture([{ sessionUpdate: "tool_call", toolCallId: "agent", kind: "other", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "agent", status: "completed", _meta: { claudeCode: { toolName: "Agent", toolResponse: { isAsync: true } } } },
    { type: "promptComplete", response: {} }]);
  f.activity.admit("t"); const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).rejects.toThrow(/unproven/);
});
it("does not accept unsupported native adapter versions merely because a tool completed", async () => {
  const activity = new composition.WorkTurnActivities(); activity.admit("t");
  const runtime = activity.wrapRuntime({ async start(options) { return { options, agentInfo: { name: "@agentclientprotocol/codex-acp", version: "999.0.0" },
    async *prompt() { yield { sessionUpdate: "tool_call", toolCallId: "read", kind: "read", status: "completed" }; yield { type: "promptComplete", response: {} }; },
  } as unknown as AcpSession; } });
  const session = await runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(activity.drain(context)).rejects.toThrow(/unproven/);
});
it("does not certify portable subagent display lifecycle as a physical exit", async () => {
  const f = fixture([{ sessionUpdate: "subagent_spawned", sessionId: "child" },
    { sessionUpdate: "subagent_state_update", sessionId: "child", state: "failed" }, { type: "promptComplete", response: {} }]);
  f.activity.admit("t"); const session = await f.runtime.start({ agent: { command: "fixture" } });
  for await (const _ of session.prompt("hi")) {}
  await expect(f.activity.drain(context)).rejects.toThrow(/unproven/);
});
