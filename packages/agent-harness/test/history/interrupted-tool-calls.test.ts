import { describe, expect, it } from "vitest";
import { eventsToMessages } from "../../src/history/events-to-messages";
import { normalizeInterruptedToolCalls } from "../../src/history/interrupted-tool-calls";

describe("normalizeInterruptedToolCalls (Codex-style history repair)", () => {
  it.each([{ _queued: true }, { cancelled_at_ms: 1 }, { processed_at: null }])("ignores invisible inputs before pairing real tool results: %j", async (marker) => {
    const events: any[] = [
      { type: "agent.tool_use", id: "visible-tool", name: "bash", input: {} },
      { type: "user.message", id: "hidden-input", content: [{ type: "text", text: "HIDDEN" }], ...marker },
      { type: "agent.tool_result", tool_use_id: "visible-tool", content: "REAL_SUCCESS" },
    ];
    const { eventsToMessagesAsync } = await import("../../src/history/events-to-messages");
    for (const messages of [eventsToMessages(events), await eventsToMessagesAsync(events, async () => null)]) {
      const text = JSON.stringify(messages);
      expect(text).toContain("REAL_SUCCESS");
      expect(text).not.toContain("interrupted");
      expect(text).not.toContain("HIDDEN");
    }
  });
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
  it("closes trailing unanswered tool_use so model history never has unpaired ids", () => {
    // Wire idle requires_action interrupt stays a no-op, but sample building
    // must still pair every tool_use (DeepSeek 400 otherwise).
    const events: any[] = [
      { type: "user.message", id: "m1", content: [] },
      { type: "agent.tool_use", id: "t1", name: "bash", input: {} },
      { type: "agent.tool_result", tool_use_id: "t1", content: [] },
      { type: "agent.custom_tool_use", id: "c1", name: "x", input: {} },
    ];
    const out = normalizeInterruptedToolCalls(events as never) as any[];
    expect(out.map((e) => e.type)).toEqual([
      "user.message", "agent.tool_use", "agent.tool_result",
      "agent.custom_tool_use", "agent.tool_result",
    ]);
    const syn = out[out.length - 1];
    expect(syn.tool_use_id).toBe("c1");
    expect(syn.is_error).toBe(true);
    expect(JSON.stringify(syn.content)).toContain("interrupted: the execution was lost before this tool finished; it was not re-run automatically");
    const msgs = eventsToMessages(events as never);
    const calls = msgs.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "tool-call").map((p: any) => p.toolCallId);
    const results = msgs.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "tool-result").map((p: any) => p.toolCallId);
    expect(results.sort()).toEqual(calls.sort());
  });
});

import { interruptRequiresActionClosure, INTERRUPTED_TOOL_RESULT_TEXT } from "../../src/history/interrupted-tool-calls";
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
    expect(INTERRUPTED_TOOL_RESULT_TEXT).toBe("interrupted: the execution was lost before this tool finished; it was not re-run automatically");
  });
  it("is a no-op when idle end_turn", () => {
    expect(interruptRequiresActionClosure([{ type: "session.status_idle", stop_reason: { type: "end_turn" } }] as never)).toEqual([]);
  });
});

describe("normalizeInterruptedToolCalls: no-op idle interrupt (official CMA)", () => {
  const parked: any[] = [
    { type: "user.message", id: "m1", content: [{ type: "text", text: "go" }] },
    { type: "session.status_running" },
    { type: "agent.custom_tool_use", id: "c1", name: "run_tests", input: {} },
    { type: "agent.tool_use", id: "t1", name: "bash", input: {} },
    { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1", "t1"] } },
    { type: "user.interrupt", id: "x1" },
    { type: "user.custom_tool_result", custom_tool_use_id: "c1", content: [{ type: "text", text: "ok" }] },
    // DO converts the settle answer to agent.tool_result on drain
    { type: "agent.tool_result", tool_use_id: "c1", content: "ok" },
    { type: "user.tool_confirmation", tool_use_id: "t1", result: "allow" },
    { type: "agent.tool_result", tool_use_id: "t1", content: "done" },
  ];
  it("parked turn settles cleanly: no synthetic result, each id paired once with the real answer", () => {
    expect(normalizeInterruptedToolCalls(parked as never)).toBe(parked);
    const parts = eventsToMessages(parked as never).flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
    const results = parts.filter((p: any) => p.type === "tool-result");
    expect(results.map((p: any) => p.toolCallId).sort()).toEqual(["c1", "t1"]);
    expect(JSON.stringify(results)).not.toContain("interrupted: the execution was lost before this tool finished; it was not re-run automatically");
  });
  it("partially settled (resume not yet allowed) still synthesizes nothing for the answered id", () => {
    const partial = parked.slice(0, 8);
    const out = normalizeInterruptedToolCalls(partial as never) as any[];
    expect(out.filter((e) => e.type === "agent.tool_result" && e.tool_use_id === "c1")).toHaveLength(1);
  });
  it("still closes open calls when the interrupt hits a running turn", () => {
    const events: any[] = [
      { type: "session.status_running" },
      { type: "agent.tool_use", id: "t1", name: "bash", input: {} },
      { type: "user.interrupt", id: "x1" },
    ];
    const out = normalizeInterruptedToolCalls(events as never) as any[];
    expect(out.filter((e) => e.type === "agent.tool_result").map((e) => e.tool_use_id)).toEqual(["t1"]);
  });
});

describe("eventsToMessages: DeepSeek tool_use-must-be-last (pressure two_clients)", () => {
  it("reorders assistant content so tool-calls follow any interleaved mid-open agent.message text", () => {
    // Repro shape from interrupt-tip pressure FAILs: tool_use events, then
    // agent.message text from a continued step / concurrent steer reply,
    // then the real tool_result. Without reordering, DeepSeek Anthropic-
    // compat 400s: "tool_use ids were found without tool_result blocks
    // immediately after" (text sits between tool_use and tool_result).
    const events: any[] = [
      { type: "user.message", id: "m1", content: [{ type: "text", text: "scaffold" }] },
      { type: "agent.custom_tool_use", id: "c1", name: "run", input: { cmd: "true" } },
      { type: "agent.custom_tool_use", id: "c2", name: "write_file", input: { path: "a" } },
      { type: "agent.message", id: "a1", content: [{ type: "text", text: "I'll scaffold." }] },
      { type: "agent.message", id: "a2", content: [{ type: "text", text: "A0" }] },
      { type: "agent.tool_result", tool_use_id: "c2", content: [{ type: "text", text: "wrote" }] },
      { type: "agent.tool_result", tool_use_id: "c1", content: [{ type: "text", text: "ok" }] },
    ];
    const msgs = eventsToMessages(events as never) as any[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const parts = msgs[1].content as any[];
    const types = parts.map((p) => p.type);
    expect(types.filter((t) => t === "text").length).toBe(2);
    expect(types.filter((t) => t === "tool-call").length).toBe(2);
    // Every tool-call must sit after every non-tool part (moveToolUseBlocksToEnd).
    const lastText = types.lastIndexOf("text");
    const firstTool = types.indexOf("tool-call");
    expect(firstTool).toBeGreaterThan(lastText);
    expect(types.slice(firstTool).every((t) => t === "tool-call")).toBe(true);
    const results = msgs[2].content as any[];
    expect(results.map((p) => p.toolCallId).sort()).toEqual(["c1", "c2"]);
  });

  it("keeps already-trailing tool-calls stable (text then tools)", () => {
    const events: any[] = [
      { type: "user.message", id: "m1", content: [{ type: "text", text: "go" }] },
      { type: "agent.message", id: "a1", content: [{ type: "text", text: "sure" }] },
      { type: "agent.tool_use", id: "t1", name: "bash", input: {} },
      { type: "agent.tool_result", tool_use_id: "t1", content: [{ type: "text", text: "done" }] },
    ];
    const parts = (eventsToMessages(events as never) as any[])[1].content as any[];
    expect(parts.map((p) => p.type)).toEqual(["text", "tool-call"]);
  });
});

describe("normalizeInterruptedToolCalls: user.message cannot split tool_use/tool_result", () => {
  it("synthesizes before intervening user.message and drops the late real result", () => {
    const events: any[] = [
      { type: "user.message", id: "m0", content: [{ type: "text", text: "go" }] },
      { type: "agent.custom_tool_use", id: "c1", name: "run", input: {} },
      { type: "agent.message", id: "a1", content: [{ type: "text", text: "working" }] },
      { type: "user.message", id: "m1", content: [{ type: "text", text: "B1" }] },
      { type: "agent.tool_result", tool_use_id: "c1", content: [{ type: "text", text: "late real" }] },
    ];
    const out = normalizeInterruptedToolCalls(events as never) as any[];
    expect(out.map((e) => e.type)).toEqual([
      "user.message", "agent.custom_tool_use", "agent.message",
      "agent.tool_result", "user.message",
    ]);
    expect(out[3].tool_use_id).toBe("c1");
    expect(out[3].is_error).toBe(true);
    expect(JSON.stringify(out[3].content)).toContain("interrupted: the execution was lost before this tool finished; it was not re-run automatically");
    // Model sample: assistant+tools, tool results, user — never user between.
    const msgs = eventsToMessages(events as never) as any[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    const toolMsg = msgs[2].content as any[];
    expect(toolMsg.map((p) => p.toolCallId)).toEqual(["c1"]);
  });

  it("idle requires_action interrupt keeps later real settle (wire no-op)", () => {
    const events: any[] = [
      { type: "agent.custom_tool_use", id: "c1", name: "run", input: {} },
      { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1"] } },
      { type: "user.interrupt", id: "x1" },
      { type: "agent.tool_result", tool_use_id: "c1", content: [{ type: "text", text: "real" }] },
    ];
    const out = normalizeInterruptedToolCalls(events as never) as any[];
    expect(out).toBe(events); // no synth; real answer preserved
    const parts = eventsToMessages(events as never).flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
    const results = parts.filter((p: any) => p.type === "tool-result");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain("real");
    expect(JSON.stringify(results[0])).not.toContain("interrupted: the execution was lost before this tool finished; it was not re-run automatically");
  });
});

it("pairs canonical released continuation with its real result before sampling the steer", () => {
  const events: any[] = [
    { type: "agent.custom_tool_use", id: "c1", name: "run", input: {} },
    { type: "user.message", id: "steer", continuation_tool_use_ids: ["c1"], content: [{ type: "text", text: "STEER" }] },
    { type: "agent.tool_result", tool_use_id: "c1", content: [{ type: "text", text: "REAL_RANDOM_RESULT" }] },
  ];
  const before = structuredClone(events);
  const out = normalizeInterruptedToolCalls(events as never) as any[];
  expect(out.map(event => event.type)).toEqual(["agent.custom_tool_use", "agent.tool_result", "user.message"]);
  expect(JSON.stringify(out)).toContain("REAL_RANDOM_RESULT");
  expect(JSON.stringify(out)).not.toContain("interrupted:");
  expect(events).toEqual(before);
  const messages = eventsToMessages(events as never);
  expect(messages.map(message => message.role)).toEqual(["assistant", "tool", "user"]);
  expect(JSON.stringify(messages)).toContain("REAL_RANDOM_RESULT");
});


it("retains a late custom answer when pre-admitted steering is consumed between parked replies", () => {
  const events: any[] = [
    { type: "agent.custom_tool_use", id: "first", name: "approve", input: {} },
    { type: "agent.tool_use", id: "ordinary", name: "bash", input: {} },
    { type: "agent.custom_tool_use", id: "last", name: "approve", input: {} },
    { type: "agent.tool_result", tool_use_id: "ordinary", content: "one ordinary effect" },
    { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["first", "last"] } },
    { type: "agent.tool_result", tool_use_id: "first", content: "first answer" },
    { type: "user.message", content: [{ type: "text", text: "queued steering" }] },
    { type: "agent.tool_result", tool_use_id: "last", content: "last answer" },
    { type: "session.status_running" },
  ];
  const before = structuredClone(events);
  const messages = eventsToMessages(events as never);
  expect(messages.map(message => message.role)).toEqual(["assistant", "tool", "user"]);
  expect(JSON.stringify(messages)).toContain("last answer");
  expect(JSON.stringify(messages)).not.toContain("interrupted:");
  expect(events).toEqual(before);
  // A reply arriving after another model turn really started must not be
  // moved backwards into an obsolete call batch.
  events.splice(7, 0, { type: "session.status_running" }, { type: "span.model_request_start" });
  expect(JSON.stringify(eventsToMessages(events as never))).toContain("interrupted:");
});
