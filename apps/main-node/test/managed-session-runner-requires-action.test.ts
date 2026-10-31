import { describe, expect, it } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { createSessionClockRegistry } from "@open-managed-agents/shared";
import type { Environment, Session, SessionEventView } from "@open-managed-agents/managed-agents-application";
import type { NodeManagedSessionRunnerAcceptInput } from "../../../packages/control-plane-node/src/lib/node-managed-session-runtime.js";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";
import { outstandingRequiresAction } from "../../../packages/control-plane-node/src/lib/requires-action.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-25T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

type Ev = NodeManagedSessionRunnerAcceptInput["events"][number];
type Frame = { id: string; type: string; processed_at: string; [k: string]: unknown };

const T0 = "2026-10-31T14:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/** Harness that, when `park` is set, emits the given custom/ask tool uses and
 * leaves them pending (as the CF default loop does). */
async function setup(park: Array<{ id: string; type: "agent.custom_tool_use" | "agent.tool_use" }> = []) {
  let runs = 0;
  let nextId = 0;
  const executions: string[] = [];
  let parkNext = park;
  const runner = new DefaultNodeManagedSessionRunner({
    sessionClocks: createSessionClockRegistry(),
    outcomes: { evaluate: async () => { throw new Error("unexpected"); } },
    confirmedTools: {
      execute: async (input: { toolUse: { id: string } }) => {
        executions.push(input.toolUse.id);
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    },
    buildSandbox: async () => ({}) as SandboxExecutor,
    buildModel: async () => ({}),
    buildTools: async () => ({}),
    buildHarness: () => ({
      run: async (ctx: { runtime: { broadcast(e: unknown): void; pendingConfirmations: string[] } }) => {
        runs += 1;
        for (const call of parkNext) {
          ctx.runtime.broadcast({ id: call.id, type: call.type, name: "tool", input: {},
            ...(call.type === "agent.tool_use" && { evaluated_permission: "ask" }) });
          ctx.runtime.pendingConfirmations.push(call.id);
        }
        parkNext = [];
      },
    }),
    buildHarnessContext: async (input: unknown) => input,
    clock: { now: () => new Date(T0) },
    ids: { nextEventId: () => `sevt_${++nextId}` },
  } as unknown as ConstructorParameters<typeof DefaultNodeManagedSessionRunner>[0]);
  await runner.start({ workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [] });
  const history: SessionEventView[] = [];
  const wire: Frame[] = [];
  const send = async (events: Ev[]) => {
    const out: Frame[] = [];
    history.push(...(events as SessionEventView[]));
    await runner.accept({
      workspaceId: "workspace_01", sessionId: session.id, session, environment,
      events, initialEvents: [], historyEvents: [...history],
      output: async (frame) => { out.push(frame as Frame); },
    });
    wire.push(...out);
    // Feed produced frames back as history (as the driver projection would).
    for (const f of out) history.push(decode(f));
    return out;
  };
  return { send, runs: () => runs, executions, wire };
}

/** Minimal wire->view decode for the event kinds used here. */
function decode(f: Frame): SessionEventView {
  const base = { id: f.id, processedAt: f.processed_at };
  switch (f.type) {
    case "session.status_idle": {
      const r = f.stop_reason as { type: string; event_ids?: string[] };
      return { ...base, type: f.type, stopReason: r.type === "requires_action" ? { type: "requires_action", eventIds: r.event_ids! } : { type: r.type } } as SessionEventView;
    }
    case "agent.tool_result":
      return { ...base, type: f.type, toolUseId: f.tool_use_id, content: f.content, isError: f.is_error } as SessionEventView;
    case "agent.tool_use":
      return { ...base, type: f.type, name: "tool", input: {}, evaluatedPermission: "ask" } as SessionEventView;
    case "agent.custom_tool_use":
      return { ...base, type: f.type, name: "tool", input: {} } as SessionEventView;
    default:
      return { ...base, type: f.type } as SessionEventView;
  }
}

const msg = (id: string): Ev => ({ id, type: "user.message", content: [{ type: "text", text: "go" }], processedAt: at(-1000) } as Ev);
const customResult = (id: string, callId: string): Ev => ({ id, type: "user.custom_tool_result", customToolUseId: callId, content: [{ type: "text", text: "42" }], processedAt: at(-500) } as Ev);
const confirm = (id: string, callId: string, result: "allow" | "deny"): Ev => ({ id, type: "user.tool_confirmation", toolUseId: callId, result, processedAt: at(-500) } as Ev);
const idleOf = (out: Frame[]) => out.filter((f) => f.type === "session.status_idle").map((f) => f.stop_reason);
const types = (out: Frame[]) => out.map((f) => f.type);

describe("Node managed runner requires_action (CMA parity, #398)", () => {
  it("parks on a custom tool call and resumes sampling once the client answers", async () => {
    const s = await setup([{ id: "call_custom_1", type: "agent.custom_tool_use" }]);
    const first = await s.send([msg("u1")]);
    expect(idleOf(first)).toEqual([{ type: "requires_action", event_ids: ["call_custom_1"] }]);
    expect(s.runs()).toBe(1);
    const second = await s.send([customResult("u2", "call_custom_1")]);
    expect(types(second)[0]).toBe("session.status_running");
    expect(idleOf(second)).toEqual([{ type: "end_turn" }]);
    expect(s.runs()).toBe(2);
  });

  it.each(["allow", "deny"] as const)("parks on an ask-permission call and resumes after %s", async (verdict) => {
    const s = await setup([{ id: "call_ask_1", type: "agent.tool_use" }]);
    expect(idleOf(await s.send([msg("u1")]))).toEqual([{ type: "requires_action", event_ids: ["call_ask_1"] }]);
    const out = await s.send([confirm("u2", "call_ask_1", verdict)]);
    expect(types(out)).toEqual(["session.status_running", "agent.tool_result", "session.status_idle"]);
    expect(out[1]!.is_error).toBe(verdict === "deny");
    expect(s.executions).toEqual(verdict === "allow" ? ["call_ask_1"] : []);
    expect(idleOf(out)).toEqual([{ type: "end_turn" }]);
    expect(s.runs()).toBe(2);
  });

  it("re-announces shrinking event_ids on partial batch answers without sampling", async () => {
    const s = await setup([
      { id: "c1", type: "agent.custom_tool_use" },
      { id: "c2", type: "agent.custom_tool_use" },
      { id: "a3", type: "agent.tool_use" },
    ]);
    expect(idleOf(await s.send([msg("u1")]))).toEqual([{ type: "requires_action", event_ids: ["c1", "c2", "a3"] }]);
    const p1 = await s.send([customResult("u2", "c2")]);
    expect(types(p1)).toEqual(["session.status_idle"]);
    expect(idleOf(p1)).toEqual([{ type: "requires_action", event_ids: ["c1", "a3"] }]);
    const p2 = await s.send([confirm("u3", "a3", "allow")]);
    expect(types(p2)).toEqual(["agent.tool_result", "session.status_idle"]);
    expect(idleOf(p2)).toEqual([{ type: "requires_action", event_ids: ["c1"] }]);
    expect(s.runs()).toBe(1);
    const done = await s.send([customResult("u4", "c1")]);
    expect(types(done)[0]).toBe("session.status_running");
    expect(idleOf(done)).toEqual([{ type: "end_turn" }]);
    expect(s.runs()).toBe(2);
  });

  it("interrupt while parked closes pending calls with the CMA error text and idles end_turn without sampling", async () => {
    const s = await setup([{ id: "c1", type: "agent.custom_tool_use" }, { id: "a2", type: "agent.tool_use" }]);
    await s.send([msg("u1")]);
    const out = await s.send([{ id: "u2", type: "user.interrupt", processedAt: at(-100) } as Ev]);
    expect(types(out)).toEqual(["agent.tool_result", "agent.tool_result", "session.status_idle"]);
    for (const f of out.slice(0, 2)) {
      expect(f.is_error).toBe(true);
      expect(f.content).toEqual([{ type: "text", text: "Tool execution was interrupted before completion. Please retry." }]);
    }
    expect(idleOf(out)).toEqual([{ type: "end_turn" }]);
    expect(s.runs()).toBe(1);
    // processed_at strictly increasing from the shared per-session clock
    const ms = s.wire.map((f) => Date.parse(f.processed_at));
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1]!);
  });

  it("a late answer to a closed call has no effect", async () => {
    const s = await setup([{ id: "c1", type: "agent.custom_tool_use" }]);
    await s.send([msg("u1")]);
    await s.send([{ id: "u2", type: "user.interrupt", processedAt: at(-100) } as Ev]);
    expect(await s.send([customResult("u3", "c1")])).toEqual([]);
    expect(await s.send([confirm("u4", "c1", "allow")])).toEqual([]);
    expect(s.runs()).toBe(1);
    expect(s.executions).toEqual([]);
  });

  it("does not park on calls already closed before the turn ended (CF 85d17d1 parity)", async () => {
    const s = await setup([{ id: "c1", type: "agent.custom_tool_use" }]);
    // simulate a steer closing c1 in the same run: closure written via history helper
    expect(outstandingRequiresAction([
      { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1", "c2"] } },
      { type: "agent.tool_result", tool_use_id: "c1" },
    ])).toEqual(["c2"]);
    expect(outstandingRequiresAction([{ type: "session.status_idle", stop_reason: { type: "end_turn" } }])).toBeNull();
    void s;
  });
});

describe("Node requires_action: queued user.message and mid-batch steer (#398)", () => {
  it("a user.message to a parked session closes the unanswered calls and runs as the next turn", async () => {
    const s = await setup([{ id: "c1", type: "agent.custom_tool_use" }, { id: "a2", type: "agent.tool_use" }]);
    await s.send([msg("u1")]);
    const out = await s.send([msg("u2")]);
    expect(types(out)).toEqual(["agent.tool_result", "agent.tool_result", "session.status_running", "session.status_idle"]);
    expect(out.slice(0, 2).map((f) => f.tool_use_id)).toEqual(["c1", "a2"]);
    for (const f of out.slice(0, 2)) expect(f.is_error).toBe(true);
    expect(idleOf(out)).toEqual([{ type: "end_turn" }]);
    expect(s.runs()).toBe(2);
    // late answers to the superseded calls are no-effect
    expect(await s.send([customResult("u3", "c1")])).toEqual([]);
    expect(await s.send([confirm("u4", "a2", "allow")])).toEqual([]);
    expect(s.executions).toEqual([]);
    expect(s.runs()).toBe(2);
  });

  it("a user.message batched with an answer keeps the answer and closes only the rest", async () => {
    const s = await setup([{ id: "c1", type: "agent.custom_tool_use" }, { id: "c2", type: "agent.custom_tool_use" }]);
    await s.send([msg("u1")]);
    // answers c1 after the park (partial), then a message arrives for the rest
    const p = await s.send([customResult("u2", "c1")]);
    expect(idleOf(p)).toEqual([{ type: "requires_action", event_ids: ["c2"] }]);
    const out = await s.send([msg("u3")]);
    expect(out.filter((f) => f.type === "agent.tool_result").map((f) => f.tool_use_id)).toEqual(["c2"]);
    expect(idleOf(out)).toEqual([{ type: "end_turn" }]);
  });

  it("steer closing parallel calls mid-batch: the final idle omits closed ids (CF bug 3 / 85d17d1 parity)", async () => {
    let nextId = 0;
    const runner = new DefaultNodeManagedSessionRunner({
      sessionClocks: createSessionClockRegistry(),
      outcomes: { evaluate: async () => { throw new Error("unexpected"); } },
      confirmedTools: { execute: async () => ({ content: [], isError: false }) },
      buildSandbox: async () => ({}) as SandboxExecutor,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (ctx: { runtime: { broadcast(e: unknown): void; pendingConfirmations: string[] } }) => {
          // parallel batch: w1, w2 (ask) + c3 (custom); a promoted steer closes w1, w2
          for (const id of ["w1", "w2"]) {
            ctx.runtime.broadcast({ id, type: "agent.tool_use", name: "write_file", input: {}, evaluated_permission: "ask" });
            ctx.runtime.pendingConfirmations.push(id);
          }
          ctx.runtime.broadcast({ id: "c3", type: "agent.custom_tool_use", name: "t", input: {} });
          ctx.runtime.pendingConfirmations.push("c3");
          for (const id of ["w1", "w2"]) {
            ctx.runtime.broadcast({ type: "agent.tool_result", tool_use_id: id, content: [{ type: "text", text: "superseded" }], is_error: true });
          }
        },
      }),
      buildHarnessContext: async (input: unknown) => input,
      clock: { now: () => new Date(T0) },
      ids: { nextEventId: () => `sevt_${++nextId}` },
    } as unknown as ConstructorParameters<typeof DefaultNodeManagedSessionRunner>[0]);
    await runner.start({ workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [] });
    const out: Frame[] = [];
    await runner.accept({
      workspaceId: "workspace_01", sessionId: session.id, session, environment,
      events: [msg("u1")], initialEvents: [], historyEvents: [msg("u1") as SessionEventView],
      output: async (frame) => { out.push(frame as Frame); },
    });
    expect(idleOf(out)).toEqual([{ type: "requires_action", event_ids: ["c3"] }]);
  });
});
