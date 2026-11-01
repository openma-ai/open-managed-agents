import { describe, expect, it } from "vitest";
import { eventsToMessages, normalizeInterruptedToolCalls } from "../../apps/agent/src/runtime/history";

describe("normalizeInterruptedToolCalls (Codex-style history repair)", () => {
  it("interrupt + user.message in one batch: next turn history pairs every pending id", () => {
    const events: any[] = [
      { type: "user.message", id: "m1", content: [{ type: "text", text: "go" }] },
      { type: "agent.tool_use", id: "t1", name: "bash", input: { command: "sleep 100" } },
      { type: "agent.custom_tool_use", id: "c1", name: "run_tests", input: {} },
      { type: "user.interrupt", id: "x1" },
      { type: "user.message", id: "m2", content: [{ type: "text", text: "next" }] },
    ];
    const out = normalizeInterruptedToolCalls(events as never) as any[];
    expect(out.map((e) => e.type)).toEqual(["user.message", "agent.tool_use", "agent.custom_tool_use",
      "agent.tool_result", "agent.tool_result", "user.interrupt", "user.message"]);
    expect(out.filter((e) => e.type === "agent.tool_result").map((e) => [e.tool_use_id, e.is_error])).toEqual([["t1", true], ["c1", true]]);
    const msgs = eventsToMessages(events as never);
    const calls = msgs.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "tool-call").map((p: any) => p.toolCallId);
    const results = msgs.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "tool-result").map((p: any) => p.toolCallId);
    expect(results.sort()).toEqual(calls.sort());
  });
  it("leaves a trailing genuinely-pending tool_use and answered calls alone", () => {
    const events: any[] = [
      { type: "user.message", id: "m1", content: [] },
      { type: "agent.tool_use", id: "t1", name: "bash", input: {} },
      { type: "agent.tool_result", tool_use_id: "t1", content: [] },
      { type: "agent.custom_tool_use", id: "c1", name: "x", input: {} },
    ];
    expect(normalizeInterruptedToolCalls(events as never)).toBe(events);
  });
});

import { interruptRequiresActionClosure, INTERRUPTED_TOOL_RESULT_TEXT } from "../../apps/agent/src/runtime/history";
describe("interruptRequiresActionClosure (shared CF/Node core)", () => {
  // Official CMA: interrupt against already-idle (including requires_action)
  // is a no-op — do not invent tool_results or overwrite stop_reason.
  it("is a no-op while parked on requires_action", () => {
    const ev: any[] = [
      { type: "user.message", id: "m", content: [] },
      { type: "session.status_running" },
      { type: "agent.custom_tool_use", id: "c1", name: "x", input: {} },
      { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1"] } },
    ];
    expect(interruptRequiresActionClosure(ev as never)).toEqual([]);
    expect(INTERRUPTED_TOOL_RESULT_TEXT).toBe("Tool execution was interrupted before completion. Please retry.");
  });
  it("is a no-op when idle end_turn", () => {
    expect(interruptRequiresActionClosure([{ type: "session.status_idle", stop_reason: { type: "end_turn" } }] as never)).toEqual([]);
  });
});
