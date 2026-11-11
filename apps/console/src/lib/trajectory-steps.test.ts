import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  MIN_GROUP_SIZE,
  autoPxPerMs,
  buildTimeScale,
  buildTrace,
  buildTurnTree,
  eventText,
  extractDiff,
  filterSteps,
  flattenEvents,
  formatClock,
  formatTokens,
  gapLabel,
  groupSteps,
  isGroupNode,
  isShellTool,
  layoutOverview,
  nodeSteps,
  normalizeEvent,
  normalizeEvents,
  oneLine,
  resolveEventTime,
  stepFilterKind,
  summarizeToolInput,
  toolCounts,
  transcriptText,
  wallTicks,
  type StepFilterKind,
  type TraceAgentNode,
} from "./trajectory-steps";
import { MAX_CHART_PX, type TraceStep } from "../components/timeline/types";

const T0 = Date.parse("2026-11-07T00:00:00Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

/** Wrap a session event the way the trajectory envelope stores it. */
function stored(seq: number, ms: number, ev: Record<string, unknown>) {
  return { seq, type: ev.type, data: JSON.stringify(ev), ts: iso(ms) };
}

describe("normalizeEvent", () => {
  it("unwraps StoredEvent rows and keeps envelope seq/ts", () => {
    const e = normalizeEvent(stored(7, 1500, { type: "agent.message", content: [{ type: "text", text: "hi" }] }), 3)!;
    expect(e).toMatchObject({ index: 3, type: "agent.message", seq: 7, ts: T0 + 1500 });
    expect(eventText(e.raw)).toBe("hi");
  });

  it("accepts already-flattened events", () => {
    const e = normalizeEvent({ type: "agent.message", text: "flat", ts: iso(0) }, 0)!;
    expect(e.type).toBe("agent.message");
    expect(e.seq).toBeNull();
    expect(eventText(e.raw)).toBe("flat");
  });

  it("prefers occurred_at, including inside span data", () => {
    expect(normalizeEvent({ type: "x", occurred_at: iso(5), ts: iso(9) }, 0)!.ts).toBe(T0 + 5);
    expect(normalizeEvent({ type: "span.x", data: { occurred_at: iso(6) } }, 0)!.ts).toBe(T0 + 6);
  });

  it("falls back to the envelope row when data is malformed", () => {
    const e = normalizeEvent({ seq: 1, type: "agent.message", data: "{nope", ts: iso(0) }, 0)!;
    expect(e.type).toBe("agent.message");
    expect(e.raw.data).toBe("{nope");
  });

  it("takes the outer type when the payload lacks one", () => {
    expect(normalizeEvent({ seq: 1, type: "agent.message", data: JSON.stringify({ text: "x" }), ts: "" }, 0)!.type).toBe("agent.message");
  });

  it("drops non-objects and untyped entries", () => {
    expect(normalizeEvent(null, 0)).toBeNull();
    expect(normalizeEvent("x", 0)).toBeNull();
    expect(normalizeEvent({ data: "{}" }, 0)).toBeNull();
    expect(normalizeEvents([null, { type: "a" }, 3])).toHaveLength(1);
    expect(normalizeEvents(undefined)).toEqual([]);
  });
});

describe("resolveEventTime", () => {
  it("handles ISO strings, unix seconds, ms, numeric strings, and junk", () => {
    expect(resolveEventTime(iso(0))).toBe(T0);
    expect(resolveEventTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(resolveEventTime(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(resolveEventTime("1700000000")).toBe(1_700_000_000_000);
    expect(resolveEventTime("1700000000123")).toBe(1_700_000_000_123);
    expect(resolveEventTime("garbage", 0, undefined)).toBeNull();
  });
});

describe("text helpers", () => {
  it("eventText reads content strings, blocks, and fallbacks", () => {
    expect(eventText({ content: "plain" })).toBe("plain");
    expect(eventText({ content: ["a", { type: "text", text: "b" }, { type: "thinking", thinking: "c" }, { type: "image" }] })).toBe("a\nb\nc\n[image]");
    expect(eventText({ content: [] , message: "m" })).toBe("m");
    expect(eventText({ error: { message: "boom" } })).toBe("boom");
    expect(eventText({})).toBe("");
  });

  it("oneLine picks the first non-empty line and truncates", () => {
    expect(oneLine("\n  first \nsecond")).toBe("first");
    expect(oneLine("x".repeat(10), 5)).toBe("xxxx…");
    expect(oneLine("")).toBe("");
  });

  it("summarizeToolInput prefers telling fields", () => {
    expect(summarizeToolInput({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolInput({ file_path: "/a.ts", content: "…" })).toBe("/a.ts");
    expect(summarizeToolInput({ n: 1 })).toBe('{"n":1}');
    expect(summarizeToolInput({})).toBe("");
    expect(summarizeToolInput("raw")).toBe("raw");
    expect(summarizeToolInput([1, 2])).toBe("[1,2]");
    expect(summarizeToolInput(undefined)).toBe("");
  });

  it("isShellTool", () => {
    expect(isShellTool("bash")).toBe(true);
    expect(isShellTool("Bash")).toBe(true);
    expect(isShellTool("read")).toBe(false);
    expect(isShellTool(undefined)).toBe(false);
  });

  it("formatTokens", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(45_000)).toBe("45k");
    expect(formatTokens(3_400_000)).toBe("3.4M");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

/** Flat live-style event with an ISO ts at T0 + ms. */
const ev = (ms: number, e: Record<string, unknown>) => ({ ...e, ts: iso(ms) });

/** user asks → model → read + mcp search (error) → model → custom tool → answer. */
function sampleRun() {
  return [
    stored(1, 0, { type: "user.message", id: "u1", content: [{ type: "text", text: "Fix the bug" }] }),
    stored(2, 100, { type: "span.model_request_start", id: "m1", model: "claude-sonnet-4-6" }),
    stored(3, 900, { type: "span.model_request_end", model_request_start_id: "m1", model_usage: { input_tokens: 1000, output_tokens: 50 }, finish_reason: "tool-calls" }),
    stored(4, 1000, { type: "agent.thinking", id: "th1", content: [{ type: "text", text: "Look at files" }] }),
    stored(5, 1000, { type: "agent.tool_use", id: "c1", name: "read", input: { file_path: "/a.ts" } }),
    stored(6, 1100, { type: "agent.mcp_tool_use", id: "c2", name: "search", mcp_server_name: "gh", input: { query: "bug" } }),
    stored(7, 1300, { type: "agent.tool_result", tool_use_id: "c1", content: "file body" }),
    stored(8, 1600, { type: "agent.mcp_tool_result", mcp_tool_use_id: "c2", content: [{ type: "text", text: "not found" }], is_error: true }),
    stored(9, 1700, { type: "span.model_request_start", id: "m2" }),
    stored(10, 2500, { type: "span.model_request_end", data: { model_request_start_id: "m2", model_usage: { input_tokens: 2000, output_tokens: 80 } } }),
    stored(11, 2600, { type: "agent.custom_tool_use", id: "c3", name: "deploy", input: { environment: "staging" } }),
    stored(12, 2700, { type: "session.status_idle", stop_reason: { type: "requires_action" } }),
    stored(13, 3000, { type: "user.custom_tool_result", custom_tool_use_id: "c3", content: [{ type: "text", text: "ok" }] }),
    stored(14, 3100, { type: "agent.message", id: "a1", content: [{ type: "text", text: "Fixed it." }] }),
    stored(15, 3200, { type: "session.status_idle" }),
  ];
}

describe("flattenEvents", () => {
  it("unwraps envelope rows and keeps the row time and seq", () => {
    const [e] = flattenEvents([stored(4, 250, { type: "agent.message", text: "x" })]);
    expect(e).toMatchObject({ type: "agent.message", text: "x", seq: 4, ts: iso(250) });
  });

  it("leaves an event's own time alone and never invents one", () => {
    const [own, none] = flattenEvents([
      { type: "agent.message", occurred_at: iso(5), ts: iso(9) },
      { type: "agent.message" },
    ]);
    expect(own!.ts).toBe(iso(9));
    expect(none!.ts).toBeUndefined();
  });
});

describe("buildTrace — turns (original Timeline semantics)", () => {
  it("opens turns only on user triggers and closes them on status_idle", () => {
    const p = buildTrace(sampleRun());
    // Tool results never open a turn; the custom tool result does (it is a trigger).
    expect(p.turns.map((t) => [t.turn.triggerKind, t.turn.status, t.closed])).toEqual([
      ["user_message", "completed", true],
      ["custom_tool_result", "completed", true],
    ]);
    expect(p.turns[0]).toMatchObject({ startTs: T0, endTs: T0 + 2700, durationMs: 2700, toolCalls: 3, errors: 1 });
    expect(p.turns[0]!.tokens).toEqual({ input: 3000, output: 130, cacheRead: 0, calls: 2 });
    expect(p.turns[1]!.tokens).toBeNull();
    expect(p.turns[0]!.triggerText).toBe("Fix the bug");
    expect(p).toMatchObject({ startTs: T0, endTs: T0 + 3200, toolCalls: 3, errors: 1, models: ["claude-sonnet-4-6"] });
  });

  it("pairs tool_use / mcp_tool_use / custom_tool_use with results by call id, across turns", () => {
    const p = buildTrace(sampleRun());
    const tools = p.steps.filter((s) => s.kind === "tool");
    expect(tools.map((t) => [t.label, t.toolSource, t.output, t.isError, t.durationMs, t.pending])).toEqual([
      ["read", "builtin", "file body", false, 300, false],
      ["gh:search", "mcp", "not found", true, 500, false],
      ["deploy", "custom", "ok", false, 400, false],
    ]);
    // The deploy call lives in turn 1 even though its result opened turn 2.
    expect(p.turns[0]!.steps.some((s) => s.toolName === "deploy")).toBe(true);
    expect(tools[0]!.events.map((e) => e.seq)).toEqual([5, 7]);
    expect(tools[1]!.errorText).toBe("not found");
  });

  it("pairs model spans by start id (top level or in data) and reports only real usage", () => {
    const p = buildTrace(sampleRun());
    const models = p.steps.filter((s) => s.kind === "model");
    expect(models.map((m) => [m.label, m.durationMs, m.usage?.output_tokens, m.finishReason])).toEqual([
      ["Generation · claude-sonnet-4-6", 800, 50, "tool-calls"],
      ["Generation", 800, 80, undefined],
    ]);
  });

  it("keeps an unclosed turn open and never fabricates its end", () => {
    const p = buildTrace([ev(0, { type: "user.message", text: "go" }), ev(500, { type: "agent.message", text: "working" })]);
    expect(p.turns[0]).toMatchObject({ closed: false, endTs: null, lastTs: T0 + 500, durationMs: 500 });
    expect(p.turns[0]!.turn.status).toBe("running");
  });

  it("marks errored / terminated turns from session.error / status_terminated", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "a" }),
      ev(10, { type: "session.error", error: { type: "x", message: "boom" } }),
      ev(20, { type: "user.message", text: "b" }),
      ev(30, { type: "session.status_terminated" }),
    ]);
    expect(p.turns.map((t) => t.turn.status)).toEqual(["errored", "terminated"]);
    const err = p.steps.find((s) => s.kind === "error")!;
    expect(err).toMatchObject({ isError: true, errorText: "boom", detail: "boom" });
  });

  it("keeps orphan results and pending calls visible", () => {
    const p = buildTrace([
      { type: "agent.tool_result", tool_use_id: "ghost", content: "late" },
      { type: "agent.tool_use", id: "y", name: "read", input: { path: "/x" } },
      { type: "span.model_request_start", id: "open" },
    ]);
    const [orphan, pending, model] = p.steps;
    expect(orphan).toMatchObject({ orphan: true, callId: "ghost", output: "late", kind: "tool" });
    expect(pending).toMatchObject({ pending: true, endTs: null, durationMs: null, detail: "/x" });
    expect(model).toMatchObject({ pending: true, durationMs: null, kind: "model" });
  });

  it("missing timestamps stay null — never 0 — and produce no gaps", () => {
    const p = buildTrace([
      { type: "user.message", text: "a" },
      { type: "agent.tool_use", id: "t", name: "read", input: {} },
      { type: "agent.tool_result", tool_use_id: "t", content: "x" },
      { type: "session.status_idle" },
      { type: "user.message", text: "b" },
    ]);
    expect(p.startTs).toBeNull();
    expect(p.steps.every((s) => s.startTs === null)).toBe(true);
    expect(p.steps.find((s) => s.kind === "tool")).toMatchObject({ durationMs: null, pending: false });
    expect(p.turns[0]).toMatchObject({ startTs: null, durationMs: null, closed: false });
    expect(p.gaps).toEqual([]);
  });

  it("flags model errors", () => {
    const p = buildTrace([
      ev(0, { type: "span.model_request_start", id: "m" }),
      ev(5, { type: "span.model_request_end", model_request_start_id: "m", is_error: true, error_message: "overloaded" }),
    ]);
    expect(p.steps[0]).toMatchObject({ isError: true, errorText: "overloaded", durationMs: 5 });
  });
});

describe("buildTrace — gaps between turns", () => {
  const twoTurns = (extra: Record<string, unknown> = {}) => [
    ev(0, { type: "user.message", text: "a" }),
    ev(100, { type: "session.status_idle" }),
    ev(300_100, { type: "user.message", text: "b", ...extra }),
    ev(300_200, { type: "session.status_idle" }),
  ];

  it("known idle: previous turn closed and next trigger is later", () => {
    const [g] = buildTrace(twoTurns()).gaps;
    expect(g).toMatchObject({ kind: "idle", afterTurn: 0, startTs: T0 + 100, endTs: T0 + 300_100, durationMs: 300_000, scheduledWakeup: false });
    expect(gapLabel(g!)).toBe("5m0s idle");
  });

  it("labels a wakeup-triggered next turn as scheduled wakeup", () => {
    const [g] = buildTrace(twoTurns({ metadata: { harness: "schedule", kind: "wakeup" } })).gaps;
    expect(gapLabel(g!)).toBe("5m0s idle · scheduled wakeup");
  });

  it("no gap when the next trigger is not after the close", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "a" }),
      ev(100, { type: "session.status_idle" }),
      ev(100, { type: "user.message", text: "b" }),
    ]);
    expect(p.gaps).toEqual([]);
  });

  it("unknown, not idle, when the previous turn has no close event", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "a" }),
      ev(50, { type: "agent.message", text: "…" }),
      ev(2050, { type: "user.message", text: "b" }),
    ]);
    expect(p.gaps).toHaveLength(1);
    expect(p.gaps[0]).toMatchObject({ kind: "unknown", startTs: T0 + 50, endTs: T0 + 2050, durationMs: 2000 });
    expect(gapLabel(p.gaps[0]!)).toBe("2.00s unknown");
    expect(p.gaps[0]!.reason).toMatch(/no close event/);
  });

  it("unknown with unknown duration when the next trigger has no timestamp", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "a" }),
      ev(100, { type: "session.status_idle" }),
      { type: "user.message", text: "b" },
    ]);
    expect(p.gaps[0]).toMatchObject({ kind: "unknown", durationMs: null });
    expect(gapLabel(p.gaps[0]!)).toBe("gap unknown");
  });

  it("span.wakeup_scheduled is an in-turn schedule wait paired via parent_event_id", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "remind me" }),
      ev(10, { type: "span.wakeup_scheduled", id: "w1" }),
      ev(20, { type: "session.status_idle" }),
      ev(60_010, { type: "user.message", parent_event_id: "w1", metadata: { harness: "schedule", kind: "wakeup" }, text: "wake" }),
      ev(60_020, { type: "span.wakeup_scheduled", id: "w2" }),
    ]);
    const [fired, pending] = p.steps.filter((s) => s.family === "schedule");
    expect(fired).toMatchObject({ label: "schedule waiting", detail: "fired", durationMs: 60_000, pending: false });
    expect(p.turns[0]!.steps).toContain(fired);
    expect(pending).toMatchObject({ detail: "pending", durationMs: null, pending: true });
    // Between-turn idle stays its own thing: close → wakeup trigger.
    expect(p.gaps[0]).toMatchObject({ kind: "idle", durationMs: 59_990, scheduledWakeup: true });
    expect(p.turns[1]!.turn.triggerKind).toBe("wakeup");
  });

  it("session.thread_idle is a zero-duration thread marker, not a turn close or idle", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "a" }),
      ev(10, { type: "session.thread_idle" }),
      ev(5000, { type: "agent.message", text: "b" }),
    ]);
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0]!.closed).toBe(false);
    expect(p.steps.find((s) => s.label === "thread_idle")).toMatchObject({ family: "thread", instant: true, durationMs: 0 });
    expect(p.gaps).toEqual([]);
  });
});

describe("buildTrace — agents only from real ancestry", () => {
  it("stays flat without session_thread_id: no synthetic root agent", () => {
    const p = buildTrace(sampleRun());
    expect(p.multiThread).toBe(false);
    const tree = buildTurnTree(p.turns[0]!.key, p.turns[0]!.steps, p);
    expect(tree.some((n) => n.type === "agent")).toBe(false);
  });

  it("nests sub-agent threads by parent_thread_id; sub-agent messages don't open turns", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "research" }),
      ev(10, { type: "session.thread_created", session_thread_id: "sthr_a", agent_name: "researcher", parent_thread_id: null }),
      ev(20, { type: "user.message", session_thread_id: "sthr_a", text: "sub task" }),
      ev(30, { type: "agent.tool_use", session_thread_id: "sthr_a", id: "x", name: "web_fetch", input: { url: "u" } }),
      ev(40, { type: "session.thread_created", session_thread_id: "sthr_b", agent_name: "fetcher", parent_thread_id: "sthr_a" }),
      ev(50, { type: "agent.message", session_thread_id: "sthr_b", text: "deep" }),
      ev(60, { type: "agent.tool_result", session_thread_id: "sthr_a", tool_use_id: "x", content: "page" }),
      ev(70, { type: "session.status_idle", session_thread_id: "sthr_a" }),
      ev(80, { type: "agent.message", text: "done" }),
      ev(90, { type: "session.status_idle" }),
    ]);
    expect(p.multiThread).toBe(true);
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0]!.endTs).toBe(T0 + 90);
    const tree = buildTurnTree(p.turns[0]!.key, p.turns[0]!.steps, p);
    const a = tree.find((n): n is TraceAgentNode => n.type === "agent")!;
    expect(a).toMatchObject({ label: "researcher", threadId: "sthr_a" });
    const b = a.children.find((n): n is TraceAgentNode => n.type === "agent")!;
    expect(b).toMatchObject({ label: "fetcher", parentThreadId: "sthr_a" });
    expect(nodeSteps(b).map((s) => s.label)).toContain("agent.message");
    // Root-thread steps hang directly off the turn.
    expect(tree.filter((n) => n.type === "step").map((n) => (n.type === "step" ? n.step.label : ""))).toEqual(["user.message", "agent.message", "session.status_idle"]);
    expect(nodeSteps(a).find((s) => s.toolName === "web_fetch")).toMatchObject({ durationMs: 30 });
  });

  it("labels a thread with no thread_created record by its id", () => {
    const p = buildTrace([ev(0, { type: "user.message", text: "a" }), ev(5, { type: "agent.message", session_thread_id: "sthr_z", text: "x" })]);
    const tree = buildTurnTree(p.turns[0]!.key, p.turns[0]!.steps, p);
    expect(tree.find((n) => n.type === "agent")).toMatchObject({ label: "sthr_z", agentName: undefined });
  });
});

function tool(key: string, name: string, extra: Partial<TraceStep> = {}): TraceStep {
  return {
    key, family: "tool", kind: "tool", label: name, startTs: null, endTs: null, durationMs: null, instant: false,
    isError: false, pending: false, orphan: false, toolName: name, toolSource: "builtin", order: 0, events: [], ...extra,
  };
}

describe("groupSteps", () => {
  it(`folds ${MIN_GROUP_SIZE}+ consecutive same-tool calls`, () => {
    const rows = groupSteps([
      tool("r1", "read", { startTs: 10, endTs: 20 }),
      tool("r2", "read", { startTs: 30, endTs: 40, isError: true }),
      tool("r3", "read", { startTs: 50 }),
      tool("m", "x", { kind: "assistant" }),
    ]);
    expect(rows).toHaveLength(2);
    const g = rows[0]!;
    if (!isGroupNode(g)) throw new Error("expected group");
    expect(g).toMatchObject({ toolName: "read", startTs: 10, endTs: 50, durationMs: 40, errors: 1, key: "group:r1" });
  });

  it("never folds shell calls, short runs, mixed tools or orphans", () => {
    expect(groupSteps([tool("b1", "bash"), tool("b2", "bash"), tool("b3", "bash")]).some(isGroupNode)).toBe(false);
    expect(groupSteps([tool("a", "read"), tool("b", "read"), tool("c", "grep")]).some(isGroupNode)).toBe(false);
    expect(groupSteps([tool("a", "read"), tool("b", "read", { orphan: true }), tool("c", "read")]).some(isGroupNode)).toBe(false);
    const untimed = groupSteps([tool("a", "glob"), tool("b", "glob"), tool("c", "glob"), tool("d", "glob")]);
    expect(untimed).toHaveLength(1);
    expect(untimed[0]).toMatchObject({ startTs: null, durationMs: null });
  });
});

describe("filters", () => {
  const p = buildTrace(sampleRun());
  const kinds = (ks: StepFilterKind[]) => ({ ...EMPTY_FILTER, kinds: new Set(ks) });

  it("empty filter keeps everything, lifecycle markers included", () => {
    expect(filterSteps(p.steps, EMPTY_FILTER)).toHaveLength(p.steps.length);
    expect(p.steps.some((s) => stepFilterKind(s) === null)).toBe(true);
  });

  it("filters by kind, with errors matching failed calls", () => {
    expect(filterSteps(p.steps, kinds(["user"])).map((s) => s.kind)).toEqual(["user"]);
    expect(filterSteps(p.steps, kinds(["tool"]))).toHaveLength(3);
    expect(filterSteps(p.steps, kinds(["model"]))).toHaveLength(2);
    expect(filterSteps(p.steps, kinds(["error"])).map((s) => s.toolName)).toEqual(["search"]);
  });

  it("filters by tool and by text over input / output", () => {
    expect(filterSteps(p.steps, { ...EMPTY_FILTER, tool: "read" }).map((s) => s.callId)).toEqual(["c1"]);
    expect(filterSteps(p.steps, { ...EMPTY_FILTER, query: "FILE BODY" })).toHaveLength(1);
    expect(filterSteps(p.steps, { ...EMPTY_FILTER, query: "staging" })[0]!.toolName).toBe("deploy");
    expect(filterSteps(p.steps, { ...EMPTY_FILTER, query: "zzz" })).toEqual([]);
  });

  it("toolCounts sorts by count then name", () => {
    expect(toolCounts([tool("1", "b"), tool("2", "a"), tool("3", "b")])).toEqual([
      { name: "b", count: 2 },
      { name: "a", count: 1 },
    ]);
  });
});

describe("transcriptText", () => {
  it("renders turns, steps and gap markers", () => {
    const p = buildTrace([
      ...sampleRun(),
      stored(16, 303_200, { type: "user.message", text: "again" }),
    ]);
    const text = transcriptText(p);
    expect(text).toContain("## Turn 1 · user message · completed · 2.70s");
    expect(text).toContain("[user] Fix the bug");
    expect(text).toContain("[thinking] Look at files");
    expect(text).toContain("[tool search · error · 500ms]");
    expect(text).toContain('"file_path": "/a.ts"');
    expect(text).toContain("output: file body");
    expect(text).toContain("[generation · claude-sonnet-4-6 · 800ms");
    expect(text).toContain("[assistant] Fixed it.");
    expect(text).toContain("--- 5m0s idle ---");
    expect(text).toContain("## Turn 3 · user message · running");
  });

  it("respects a step predicate and marks pending calls", () => {
    const p = buildTrace([{ type: "user.message", text: "x" }, { type: "agent.tool_use", id: "p", name: "read", input: "raw" }]);
    const text = transcriptText(p, (s) => s.kind === "tool");
    expect(text).toContain("[tool read · pending]\ninput: raw");
    expect(text).not.toContain("[user]");
  });
});

describe("time scale", () => {
  it("is wall-clock identity by default", () => {
    const s = buildTimeScale(1000, 11_000);
    expect(s.total).toBe(10_000);
    expect(s.toDisplay(6000)).toBe(5000);
    expect(s.toWall(5000)).toBe(6000);
    expect(s.breaks).toEqual([]);
  });

  it("a collapsed gap shrinks on the axis, keeps order, and round-trips", () => {
    // 1s of work, 1h gap, 1s of work.
    const s = buildTimeScale(0, 3_602_000, [{ key: "g", startTs: 1000, endTs: 3_601_000 }]);
    expect(s.breaks).toHaveLength(1);
    const b = s.breaks[0]!;
    expect(b.d0).toBe(1000);
    expect(b.d1 - b.d0).toBeCloseTo(60); // 3% of the 2s of non-gap time
    expect(s.total).toBeCloseTo(2060);
    expect(s.toDisplay(3_601_000)).toBeCloseTo(1060);
    expect(s.toDisplay(3_602_000)).toBeCloseTo(2060);
    expect(s.toWall(s.toDisplay(1_801_000))).toBeCloseTo(1_801_000);
    expect(s.toWall(1500)).toBeCloseTo(3_601_000 + 440);
    // Restoring = rebuilding without the interval: full wall clock again.
    expect(buildTimeScale(0, 3_602_000).total).toBe(3_602_000);
  });

  it("autoPxPerMs: median boundary gap ≈ 25px, clamped to fit and MAX_CHART_PX", () => {
    expect(autoPxPerMs([0, 100, 200, 300], 300, 600)).toBeCloseTo(2); // fit wins over 0.25
    expect(autoPxPerMs([0, 10, 20], 20, 100)).toBeCloseTo(MAX_CHART_PX / 20 > 5 ? 5 : MAX_CHART_PX / 20);
    expect(autoPxPerMs([0, 1000, 2000], 2000, 400)).toBeCloseTo(0.2);
    expect(autoPxPerMs([], 10_000_000, 800)).toBeCloseTo(800 / 10_000_000);
  });

  it("wallTicks skip collapsed gaps and stay bounded; formatClock", () => {
    const s = buildTimeScale(0, 3_602_000, [{ key: "g", startTs: 1000, endTs: 3_601_000 }]);
    const { ticks } = wallTicks(s, 0, s.total, 1);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.ts <= 1000 || t.ts >= 3_601_000)).toBe(true);
    const full = wallTicks(buildTimeScale(0, 86_400_000), 0, 86_400_000, 800 / 86_400_000);
    expect(full.ticks.length).toBeLessThanOrEqual(96);
    const d = new Date(2026, 10, 4, 7, 50, 5, 250).getTime();
    expect(formatClock(d)).toBe("7:50:05");
    expect(formatClock(d, 100)).toBe("7:50:05.250");
  });
});

describe("layoutOverview", () => {
  it("packs overlapping steps into lanes, adds markers, and extends pending bars", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "go" }),
      ev(10, { type: "agent.tool_use", id: "a", name: "read", input: {} }),
      ev(20, { type: "agent.tool_use", id: "b", name: "grep", input: {} }),
      ev(30, { type: "agent.tool_result", tool_use_id: "a", content: "" }),
      ev(40, { type: "agent.tool_result", tool_use_id: "b", content: "", is_error: true }),
      ev(50, { type: "agent.tool_use", id: "c", name: "bash", input: { command: "sleep" } }),
      ev(60, { type: "session.error", error: "died" }),
      ev(1000, { type: "user.message", text: "next" }),
      ev(1200, { type: "agent.message", text: "ok" }),
    ]);
    const layout = layoutOverview(p, buildTimeScale(p.startTs!, p.endTs!));
    expect(layout.stepBars.map((b) => [b.step.toolName, b.lane])).toEqual([["read", 0], ["grep", 1], ["bash", 0]]);
    const bash = layout.stepBars.find((b) => b.step.toolName === "bash")!;
    expect(bash).toMatchObject({ openEnded: true, d1: 1200 });
    expect(layout.markers.map((m) => m.step.kind)).toEqual(["user", "error", "user"]);
    expect(layout.turnBars.map((t) => [t.d0, t.d1, t.openEnded])).toEqual([[0, 60, false], [1000, 1200, true]]);
    expect(layout.gapBars.map((g) => [g.gap.kind, g.d0, g.d1, g.collapsed])).toEqual([["idle", 60, 1000, false]]);
  });

  it("marks collapsed gap bars and shrinks their width", () => {
    const p = buildTrace([
      ev(0, { type: "user.message", text: "a" }),
      ev(1000, { type: "session.status_idle" }),
      ev(3_601_000, { type: "user.message", text: "b" }),
      ev(3_602_000, { type: "session.status_idle" }),
    ]);
    const g = p.gaps[0]!;
    const layout = layoutOverview(p, buildTimeScale(p.startTs!, p.endTs!, [{ key: g.key, startTs: g.startTs!, endTs: g.endTs! }]));
    const bar = layout.gapBars[0]!;
    expect(bar.collapsed).toBe(true);
    expect(bar.d1 - bar.d0).toBeCloseTo(60);
    // True duration stays on the gap.
    expect(bar.gap.durationMs).toBe(3_600_000);
  });
});

describe("extractDiff", () => {
  it("renders edit-tool inputs as -/+ lines", () => {
    const d = extractDiff({ file_path: "/a.ts", old_string: "a\nb", new_string: "c" })!;
    expect(d.path).toBe("/a.ts");
    expect(d.lines).toEqual([
      { kind: "del", text: "-a" },
      { kind: "del", text: "-b" },
      { kind: "add", text: "+c" },
    ]);
    expect(extractDiff({ path: "/b", old_str: "x", new_str: "y" })!.path).toBe("/b");
  });

  it("parses unified diffs from strings and patch fields", () => {
    const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same";
    const kinds = extractDiff(patch)!.lines.map((l) => l.kind);
    expect(kinds).toEqual(["meta", "meta", "meta", "hunk", "del", "add", "ctx"]);
    expect(extractDiff({ patch })).not.toBeNull();
    expect(extractDiff({ diff: patch })).not.toBeNull();
    expect(extractDiff({ input: "*** Begin Patch\n+x" })!.lines[0]!.kind).toBe("meta");
  });

  it("returns null for non-edit payloads", () => {
    expect(extractDiff({ command: "ls" })).toBeNull();
    expect(extractDiff("just text")).toBeNull();
    expect(extractDiff(undefined)).toBeNull();
  });
});
