import { expect, it, vi } from "vitest";
import { AcpSandboxHarness } from "../../../packages/agent-harness/src/acp-sandbox-loop";
import { buildTools } from "../../../packages/agent-harness/src/tools";
import { NodeManagedConfirmedToolExecutor } from "../../../packages/control-plane-node/src/lib/node-managed-confirmed-tool-executor";

// Keep the installer and harness real; only the external ACP child is replaced.
vi.mock("../../../packages/acp-runtime/src/placement.ts", () => ({ createAcpRuntime: () => ({
  start: async () => ({ acpSessionId: "native", isAlive: () => true,
    async *prompt() { yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }; },
    dispose: async () => undefined }),
}) }));

function fixture() {
  const events: any[] = [], commands: Array<{ command: string; timeout: number }> = [];
  let failure: unknown = Object.assign(new Error("lost install response"), { outcome: "dispatched_unknown" });
  const sandbox = {
    exec: async (command: string, timeout: number) => {
      if (!command.includes("OMA_ACP_INSTALL_OK")) return "exit=0\n";
      commands.push({ command, timeout });
      if (failure) throw failure;
      return "exit=0\nOMA_ACP_LAUNCHER=/home/user/acp-launch.sh\nOMA_ACP_INSTALL_OK";
    },
    writeFile: async () => "ok", readFile: async () => { throw Error("absent"); },
    spawnDuplexProcess: async () => { throw Error("unused"); },
  };
  const agent = { id: "a", model: "test", harness: "acp-sandbox", tools: [], acp: { agent: { registry: "claude-acp@0.94.0" } } };
  const runtime: any = { sandbox, history: { getEvents: () => events }, broadcast: (event: any) => events.push(event),
    broadcastStreamStart: async () => {}, broadcastChunk: async () => {}, broadcastStreamEnd: async () => {},
    broadcastThinkingStart: async () => {}, broadcastThinkingChunk: async () => {}, broadcastThinkingEnd: async () => {} };
  const ctx: any = { agent, session_id: "s", runtime, env: {}, systemPrompt: "", userMessage: { type: "user.message", content: [{ type: "text", text: "hello" }] } };
  const run = () => new AcpSandboxHarness().run(ctx);
  const confirm = async (id: string) => {
    if (events.some(e => e.type === "agent.tool_result" && e.tool_use_id === id)) return;
    const toolUse = events.find(e => e.id === id);
    events.push({ type: "user.tool_confirmation", tool_use_id: id, result: "allow" });
    const executor = new NodeManagedConfirmedToolExecutor({ buildExecutableTools: () => buildTools(agent as never, sandbox as never, {}, { enforcePermissions: false }) });
    const result = await executor.execute({ toolUse, abortSignal: new AbortController().signal, sandbox } as never);
    runtime.broadcast({ type: "agent.tool_result", tool_use_id: id, content: result.content, is_error: result.isError });
  };
  return { sandbox, events, commands, agent, runtime, ctx, run, confirm, succeed: () => { failure = null; }, fail: (error: unknown) => { failure = error; } };
}

it("real installer unknown becomes a durable frozen request and ordinary restart cannot reinstall", async () => {
  const f = fixture();
  await f.run();
  await f.run();
  expect(f.commands).toHaveLength(1);
  const original = f.events.find(e => e.type === "agent.tool_use" && !e.id.startsWith("retry:"));
  expect(original.name).toBe("acp_install");
  expect(original.input).toEqual({ registry: "claude-acp@0.94.0", ...f.commands[0] });
  expect(original.input.command).toContain("npm exec --yes --package=");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "agent.tool_result", tool_use_id: original.id, is_error: true }));
  expect(f.runtime.pendingConfirmations).toEqual(["retry:" + original.id]);
});

it("approved frozen install executes once through real host executor, then harness consumes its output without a third install", async () => {
  const f = fixture(); await f.run();
  const retry = f.events.find(e => e.type === "agent.tool_use" && e.id.startsWith("retry:"));
  expect(retry, "unknown must expose a confirmation call").toBeDefined();
  f.succeed(); await f.confirm(retry.id); await f.run(); await f.confirm(retry.id); await f.run();
  expect(f.commands).toHaveLength(2);
  expect(f.commands[1]).toEqual(f.commands[0]);
  expect(f.events.some(e => e.type === "agent.message")).toBe(true);
});

it.each(["deny", "interrupt"])("%s permanently prevents ordinary restart from reinstalling", async action => {
  const f = fixture(); await f.run();
  const id = f.runtime.pendingConfirmations?.[0];
  expect(id).toBeDefined();
  f.events.push(action === "deny" ? { type: "user.tool_confirmation", tool_use_id: id, result: "deny" } : { type: "user.interrupt" });
  f.succeed(); await f.run(); await f.run(); expect(f.commands).toHaveLength(1);
});

it("ordinary install failure retains its registry diagnostic without claiming unknown", async () => {
  const f = fixture(); f.fail(Error("rejected before dispatch")); await f.run();
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.error", error: expect.stringContaining("ACP agent install failed for claude-acp@0.94.0: rejected before dispatch") }));
  expect(f.events.some(e => e.source === "tool_outcome_unknown")).toBe(false);
});

it("normal install success still starts and completes the real harness", async () => {
  const f = fixture(); f.succeed(); await f.run();
  expect(f.commands).toHaveLength(1);
  expect(f.events.some(e => e.type === "agent.message")).toBe(true);
  expect(f.events.some(e => e.type === "session.error")).toBe(false);
});

it("rejects a modified command at the actual host executor before any shell dispatch", async () => {
  const f = fixture(); await f.run();
  const retry = f.events.find(e => e.type === "agent.tool_use" && e.id.startsWith("retry:"));
  retry.input.command = "echo unapproved"; f.succeed(); await f.confirm(retry.id); await f.run();
  expect(f.commands).toHaveLength(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "agent.tool_result", tool_use_id: retry.id, is_error: true }));
});

it("rejects an unsupported changed registry without dispatching another installation", async () => {
  const f = fixture(); await f.run();
  const retry = f.events.find(e => e.type === "agent.tool_use" && e.id.startsWith("retry:"));
  f.succeed(); await f.confirm(retry.id);
  f.agent.acp.agent.registry = "pi-acp@0.1.0";
  await f.run(); expect(f.commands).toHaveLength(2);
});

it.each(["warning", "pre-warning"])("actual Node runner recovers %s install uncertainty across owner replacement without duplicate confirmation effects", async crash => {
  const { DefaultNodeManagedSessionRunner } = await import("../../../packages/control-plane-node/src/lib/node-managed-session-runner");
  const { decodeRuntimeEvent } = await import("@open-managed-agents/managed-agents-adapters-runtime");
  const f = fixture(); const history: any[] = [], frames: any[] = []; let sequence = 0;
  const session: any = { id: "s", agent: { id: "a", model: { id: "test" }, tools: [], mcpServers: [] }, usage: {}, status: "running", budget: null };
  const environment: any = { id: "env", config: { type: "self_hosted" } };
  const newOwner = async () => {
    const runner = new DefaultNodeManagedSessionRunner({
      buildSandbox: async () => f.sandbox,
      buildModel: async () => ({}), buildTools: async () => ({}),
      buildHarness: () => new AcpSandboxHarness(),
      buildHarnessContext: async (input: any) => ({ ...f.ctx, runtime: input.runtime }),
      confirmedTools: new NodeManagedConfirmedToolExecutor({ buildExecutableTools: () => buildTools(f.agent as never, f.sandbox as never, {}, { enforcePermissions: false }) }),
      clock: { now: () => new Date("2026-11-01T00:00:00Z") }, ids: { nextEventId: () => "e" + (++sequence) },
    } as any);
    await runner.start({ workspaceId: "w", sessionId: "s", session, environment, initialEvents: [] });
    return async (events: any[]) => {
      history.push(...events); const output: any[] = [];
      await runner.accept({ workspaceId: "w", sessionId: "s", session, environment, events, initialEvents: [], historyEvents: [...history], output: async (frame: any) => { output.push(frame); } });
      for (const frame of output) history.push(...decodeRuntimeEvent(frame, new Set()));
      frames.push(...output); return output;
    };
  };
  const msg = (id: string) => ({ id, type: "user.message", content: [{ type: "text", text: "continue" }], processedAt: "2026-11-01T00:00:00Z" });
  let send = await newOwner(); await send([msg("first")]);
  const retry = frames.find(e => e.type === "agent.tool_use" && e.id.startsWith("retry:"));
  expect(retry).toBeDefined();
  expect(frames).toContainEqual(expect.objectContaining({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [retry.id] } }));
  if (crash === "pre-warning") {
    const original = history.find(e => e.type === "agent.tool_use" && e.name === "acp_install" && !e.id.startsWith("retry:"));
    history.splice(history.indexOf(original) + 1);
  }
  send = await newOwner(); await send([msg("ordinary")]); expect(f.commands).toHaveLength(1);
  f.succeed();
  const allow = (id: string) => ({ id, type: "user.tool_confirmation", toolUseId: retry.id, result: "allow", processedAt: "2026-11-01T00:00:00Z" });
  await send([allow("allow1"), allow("allow2")]);
  expect(f.commands).toHaveLength(2);
  await send([allow("allow3")]); await send([msg("later")]);
  expect(f.commands).toHaveLength(2);
  expect(frames.filter(e => e.type === "agent.tool_result" && e.tool_use_id === retry.id)).toHaveLength(1);
});

// The break caught here is dispatch after cancellation while the real host
// executor is awaiting tool construction. Keep runner, installer, codec and
// execution guard real; only external ACP placement remains the file's double.
it.each(["interrupt", "lease_lost"])("actual host %s during confirmation preparation prevents a second installer dispatch", async action => {
  const { DefaultNodeManagedSessionRunner } = await import("../../../packages/control-plane-node/src/lib/node-managed-session-runner");
  const { decodeRuntimeEvent } = await import("@open-managed-agents/managed-agents-adapters-runtime");
  const f = fixture(); const history: any[] = [], frames: any[] = []; let sequence = 0;
  const session: any = { id: "s", agent: { id: "a", model: { id: "test" }, tools: [], mcpServers: [] }, usage: {}, status: "running", budget: null };
  const environment: any = { id: "env", config: { type: "self_hosted" } };
  const scope = { workspaceId: "w", sessionId: "s", session, environment };
  let release!: () => void, reached!: () => void;
  const prepared = new Promise<void>(resolve => { reached = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const runner = new DefaultNodeManagedSessionRunner({
    buildSandbox: async () => f.sandbox, buildModel: async () => ({}), buildTools: async () => ({}),
    buildHarness: () => new AcpSandboxHarness(),
    buildHarnessContext: async (input: any) => ({ ...f.ctx, runtime: input.runtime }),
    confirmedTools: new NodeManagedConfirmedToolExecutor({ buildExecutableTools: async (input: any) => {
      reached(); await barrier;
      return buildTools(f.agent as never, input.sandbox, {}, { enforcePermissions: false });
    } }),
    clock: { now: () => new Date("2026-11-01T00:00:00Z") }, ids: { nextEventId: () => "e" + (++sequence) },
  } as any);
  const send = async (events: any[]) => {
    history.push(...events); const output: any[] = [];
    try {
      await runner.accept({ ...scope, executionFence: { executionId: "x", attemptId: "old", ownerId: "owner" },
        events, initialEvents: [], historyEvents: [...history], output: async (frame: any) => { output.push(frame); } } as any);
    } finally {
      for (const frame of output) history.push(...decodeRuntimeEvent(frame, new Set()));
      frames.push(...output);
    }
  };
  await runner.start({ ...scope, initialEvents: [] });
  await send([{ id: "first", type: "user.message", content: [{ type: "text", text: "start" }], processedAt: "2026-11-01T00:00:00Z" }]);
  const retry = frames.find(e => e.type === "agent.tool_use" && e.id.startsWith("retry:"));
  expect(retry).toBeDefined(); expect(f.commands).toHaveLength(1); f.succeed();
  const pending = send([{ id: "allow", type: "user.tool_confirmation", toolUseId: retry.id, result: "allow", processedAt: "2026-11-01T00:00:01Z" }]);
  await prepared;
  if (action === "interrupt") await send([{ id: "interrupt", type: "user.interrupt", processedAt: "2026-11-01T00:00:02Z" }]);
  else runner.cancel({ ...scope, reason: "lease_lost" });
  release();
  if (action === "lease_lost") await expect(pending).rejects.toBe("lease_lost");
  else await pending;
  expect(f.commands).toHaveLength(1);
  expect(frames.filter(e => e.type === "agent.tool_result" && e.tool_use_id === retry.id)).toHaveLength(0);
  if (action === "lease_lost") {
    expect(frames.filter(e => e.type === "session.status_idle")).toHaveLength(1);
    expect(frames.some(e => e.type === "session.error")).toBe(false);
  }
});

it("orphan canonical install without result or warning is conservatively parked and repaired", async () => {
  const f = fixture(); await f.run();
  const original = f.events.find(e => e.type === "agent.tool_use" && !e.id.startsWith("retry:"));
  f.events.splice(f.events.indexOf(original) + 1); f.runtime.pendingConfirmations = [];
  await f.run(); await f.run();
  expect(f.commands).toHaveLength(1);
  expect(f.events.filter(e => e.type === "agent.tool_result" && e.tool_use_id === original.id)).toHaveLength(1);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.warning", source: "tool_outcome_unknown", details: expect.objectContaining({ tool_use_id: original.id, outcome: "dispatched_unknown" }) }));
  expect(f.runtime.pendingConfirmations).toEqual(["retry:" + original.id]);
});
