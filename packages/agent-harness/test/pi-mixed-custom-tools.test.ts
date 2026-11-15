// M1-M7 (PR545 mixed-tool parking): one Pi model response mixing client
// custom tools with ordinary bash / MCP tools. Faux model only; no inference.
//
// Pinned pi-agent-core 1.1.0 ends a tool batch only when EVERY result has
// terminate:true (agent-loop.js shouldTerminateToolBatch). Before the
// finishTurn park in pi-loop.ts this head sampled the model again with the
// custom call still unanswered, and recovered history became
// assistant[calls] -> tool[ordinary] -> assistant[text] -> tool[custom].
import { describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type { SessionEvent } from "@open-managed-agents/shared";
import { planRequiresActionAnswers } from "@open-managed-agents/session-runtime";
import type { HarnessContext, HarnessRuntime } from "../src/interface";
import { PiHarness } from "../src/pi-loop";

type Call = { name: "approve" | "sign" | "bash" | "mcp_docs_lookup"; id: string };
const CUSTOM = new Set(["approve", "sign"]);

/** Ordinary tool effects survive restarts: one counter per tool, per test. */
function effects() {
  return {
    bash: vi.fn(async ({ command }: { command: string }) => ({ ran: command })),
    mcp: vi.fn(async ({ query }: { query: string }) => ({ found: query })),
  };
}

/** One harness run over a persisted canonical log, as a platform composes it. */
function harness(log: SessionEvent[], responses: FauxResponseStep[], fx: ReturnType<typeof effects>) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const noop = vi.fn(async () => undefined);
  const runtime = {
    history: { getEvents: () => log, getMessages: () => [], append: (event: SessionEvent) => log.push(event) },
    sandbox: {},
    broadcast: (event: SessionEvent) => log.push(event),
    broadcastStreamStart: noop, broadcastChunk: noop, broadcastStreamEnd: noop,
    broadcastThinkingStart: noop, broadcastThinkingChunk: noop, broadcastThinkingEnd: noop,
    broadcastToolInputStart: noop, broadcastToolInputChunk: noop, broadcastToolInputEnd: noop,
    reportUsage: noop,
    // Every platform starts a run with an empty list (SessionDO, Node runner).
    pendingConfirmations: [] as string[],
  } as unknown as HarnessRuntime;
  const ctx = {
    agent: { id: "agent-mixed", model: faux.getModel().id },
    userMessage: { type: "user.message", content: [{ type: "text", text: "" }] },
    session_id: "session-mixed",
    tools: {
      bash: { description: "Run a shell command", inputSchema: z.object({ command: z.string() }), execute: fx.bash },
      mcp_docs_lookup: { description: "MCP docs lookup", inputSchema: z.object({ query: z.string() }), execute: fx.mcp },
      // Client-side custom tools: no execute, answered by user.custom_tool_result.
      approve: { description: "Client approval", inputSchema: z.object({ ticket: z.string() }) },
      sign: { description: "Client signature", inputSchema: z.object({ doc: z.string() }) },
    },
    model: {} as HarnessContext["model"],
    pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
    systemPrompt: "You are concise.",
    env: {},
    runtime,
  } as unknown as HarnessContext;
  return { ctx, faux, runtime };
}

function toolCall(call: Call) {
  const input = call.name === "bash" ? { command: `echo ${call.id}` }
    : call.name === "mcp_docs_lookup" ? { query: call.id }
    : call.name === "approve" ? { ticket: call.id } : { doc: call.id };
  return fauxToolCall(call.name, input, { id: call.id });
}

/** What the platform persists when a custom answer is accepted (CF transcript / Node mapping). */
function acceptedAnswer(id: string, shape: "cf" | "node"): SessionEvent {
  return (shape === "cf"
    ? { type: "agent.tool_result", tool_use_id: id, content: `answer:${id}`, parent_event_id: id, transcript_only: true }
    : { id: `answer-${id}`, type: "agent.tool_result", tool_use_id: id, content: [{ type: "text", text: `answer:${id}` }] }) as unknown as SessionEvent;
}

function answerBatch(ids: string[]) {
  return ids.map((id) => ({ id: `in-${id}-${Math.random().toString(36).slice(2)}`, type: "user.custom_tool_result", custom_tool_use_id: id }));
}

function park(ids: string[]): SessionEvent {
  return { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ids } } as unknown as SessionEvent;
}

const wire = (log: SessionEvent[]) => log as unknown as Array<{ type?: string; [key: string]: unknown }>;

describe("Pi harness: mixed custom + ordinary tools in one model response", () => {
  it.each<[string, Call[]]>([
    ["custom first, bash", [{ name: "approve", id: "c1" }, { name: "bash", id: "b1" }]],
    ["bash, custom last", [{ name: "bash", id: "b1" }, { name: "approve", id: "c1" }]],
    ["MCP and custom", [{ name: "mcp_docs_lookup", id: "m1" }, { name: "approve", id: "c1" }]],
    ["multiple custom with bash and MCP", [
      { name: "approve", id: "c1" }, { name: "bash", id: "b1" }, { name: "mcp_docs_lookup", id: "m1" }, { name: "sign", id: "c2" },
    ]],
    ["custom only (control)", [{ name: "approve", id: "c1" }, { name: "sign", id: "c2" }]],
  ])("%s: parks after persisting ordinary results, waits for every answer, restarts without replay", async (_label, calls) => {
    const fx = effects();
    const customIds = calls.filter((c) => CUSTOM.has(c.name)).map((c) => c.id);
    const ordinary = calls.filter((c) => !CUSTOM.has(c.name));
    const log: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "do all of it" }] } as SessionEvent];

    // ── Run 1: one sampling, ordinary tools run once, then park. ────────────
    const unexpected = vi.fn(() => fauxAssistantMessage("sampled while a custom call was unanswered"));
    const first = harness(log, [fauxAssistantMessage(calls.map(toolCall), { stopReason: "toolUse" }), unexpected], fx);
    await new PiHarness().run(first.ctx);

    expect(first.faux.state.callCount).toBe(1);
    expect(unexpected).not.toHaveBeenCalled();
    expect(fx.bash).toHaveBeenCalledTimes(ordinary.filter((c) => c.name === "bash").length);
    expect(fx.mcp).toHaveBeenCalledTimes(ordinary.filter((c) => c.name === "mcp_docs_lookup").length);
    expect([...first.runtime.pendingConfirmations!].sort()).toEqual([...customIds].sort());
    expect(log.some((e) => e.type === "agent.message")).toBe(false);
    // Every completed ordinary result is in the log the platform persists
    // when the harness returns, before it records the requires_action park.
    for (const c of ordinary) {
      expect(log.filter((e) => (e.type === "agent.tool_result" && (e as { tool_use_id?: string }).tool_use_id === c.id)
        || (e.type === "agent.mcp_tool_result" && (e as { mcp_tool_use_id?: string }).mcp_tool_use_id === c.id))).toHaveLength(1);
    }
    for (const id of customIds) {
      expect(log.some((e) => e.type === "agent.custom_tool_use" && (e as { id?: string }).id === id)).toBe(true);
      expect(log.some((e) => e.type === "agent.tool_result" && (e as { tool_use_id?: string }).tool_use_id === id)).toBe(false);
    }
    log.push(park(customIds));

    // ── Durable boundary: only the serialized canonical log survives. ───────
    const persisted = JSON.parse(JSON.stringify(log)) as SessionEvent[];

    // Partial answers never resume sampling; duplicates and replays are no-ops.
    if (customIds.length > 1) {
      const [head, ...rest] = customIds;
      const partial = answerBatch([head!]);
      expect(planRequiresActionAnswers(partial, () => wire(persisted))).toEqual({ type: "proceed", remaining: rest });
      persisted.push(acceptedAnswer(head!, "cf"), park(rest));
      expect(planRequiresActionAnswers(answerBatch([head!]), () => wire(persisted))).toEqual({ type: "no_effect" });
    }
    const pendingNow = customIds.length > 1 ? customIds.slice(1) : customIds;
    expect(planRequiresActionAnswers(answerBatch(pendingNow), () => wire(persisted))).toEqual({ type: "proceed", remaining: [] });
    pendingNow.forEach((id, i) => persisted.push(acceptedAnswer(id, i % 2 === 0 ? "node" : "cf")));

    // ── Run 2: a fresh harness over the restored log. ───────────────────────
    let seen: Array<{ role: string; content?: unknown; toolCallId?: string }> = [];
    const resumed = harness(persisted, [(context) => {
      seen = context.messages as typeof seen;
      return fauxAssistantMessage("all answers received");
    }], fx);
    await new PiHarness().run(resumed.ctx);

    expect(resumed.faux.state.callCount).toBe(1);
    // No completed ordinary tool ran again.
    expect(fx.bash).toHaveBeenCalledTimes(ordinary.filter((c) => c.name === "bash").length);
    expect(fx.mcp).toHaveBeenCalledTimes(ordinary.filter((c) => c.name === "mcp_docs_lookup").length);
    expect(resumed.runtime.pendingConfirmations).toEqual([]);
    // The model saw: user, one assistant tool-call batch, then exactly one
    // result per call and nothing else before sampling.
    // Pi 1.1.0 prepends system messages declaring the tool loadout; they may
    // only lead the transcript, never sit between a call and its results.
    const firstUser = seen.findIndex((m) => m.role === "user");
    expect(seen.slice(0, firstUser).every((m) => m.role === "system")).toBe(true);
    const turn = seen.slice(firstUser);
    expect(turn.map((m) => m.role)).toEqual(["user", "assistant", ...calls.map(() => "toolResult")]);
    const assistantCalls = (turn[1]!.content as Array<{ type: string; id?: string }>).filter((p) => p.type === "toolCall").map((p) => p.id);
    expect([...assistantCalls].sort()).toEqual(calls.map((c) => c.id).sort());
    expect(turn.slice(2).map((m) => m.toolCallId).sort()).toEqual(calls.map((c) => c.id).sort());
    expect(persisted.filter((e) => e.type === "agent.message")).toHaveLength(1);

    // A late answer for a call this turn already closed changes nothing.
    persisted.push({ type: "session.status_idle", stop_reason: { type: "end_turn" } } as unknown as SessionEvent);
    expect(planRequiresActionAnswers(answerBatch([customIds[0]!]), () => wire(persisted))).toEqual({ type: "no_effect" });
  });

  it("does not let queued steering resume sampling while a custom call is parked", async () => {
    const fx = effects();
    const log: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "go" }] } as SessionEvent];
    const unexpected = vi.fn(() => fauxAssistantMessage("sampled with a steered message"));
    const run = harness(log, [fauxAssistantMessage([toolCall({ name: "bash", id: "b1" }), toolCall({ name: "approve", id: "c1" })], { stopReason: "toolUse" }), unexpected], fx);
    // A mid-run user.message is available for absorption the whole time.
    run.runtime.takeSteeringInputs = async () => {
      return [{ id: "steer-1", type: "user.message", content: [{ type: "text", text: "also this" }] } as SessionEvent];
    };
    await new PiHarness().run(run.ctx);
    expect(run.faux.state.callCount).toBe(1);
    expect(unexpected).not.toHaveBeenCalled();
    expect(run.runtime.pendingConfirmations).toEqual(["c1"]);
    expect(fx.bash).toHaveBeenCalledTimes(1);
  });
});
