import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  MIN_GROUP_SIZE,
  buildLanes,
  eventText,
  extractDiff,
  filterSteps,
  formatTokens,
  groupSteps,
  isGroupRow,
  isShellTool,
  normalizeEvent,
  normalizeEvents,
  oneLine,
  projectTrajectory,
  resolveEventTime,
  segmentPosition,
  stepFilterKind,
  summarizeToolInput,
  toolCounts,
  transcriptText,
  type StepFilterKind,
  type TrajectoryStep,
} from "./trajectory-steps";

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

/** A two-turn run: user asks, model reads twice + runs bash, then answers. */
function sampleRun() {
  return [
    stored(1, 0, { type: "user.message", id: "u1", content: [{ type: "text", text: "Fix the bug" }] }),
    stored(2, 100, { type: "span.model_request_start", id: "m1" }),
    stored(3, 900, { type: "span.model_request_end", model_request_start_id: "m1", model_usage: { input_tokens: 1000, output_tokens: 50 } }),
    stored(4, 1000, { type: "agent.thinking", id: "th1", content: [{ type: "text", text: "Look at files" }] }),
    stored(5, 1000, { type: "agent.tool_use", id: "c1", name: "read", input: { file_path: "/a.ts" } }),
    stored(6, 1100, { type: "agent.mcp_tool_use", id: "c2", name: "search", mcp_server_name: "gh", input: { query: "bug" } }),
    stored(7, 1300, { type: "agent.tool_result", tool_use_id: "c1", content: "file body" }),
    stored(8, 1600, { type: "agent.mcp_tool_result", mcp_tool_use_id: "c2", content: [{ type: "text", text: "not found" }], is_error: true }),
    stored(9, 1700, { type: "span.model_request_start", id: "m2" }),
    stored(10, 2500, { type: "span.model_request_end", data: { model_request_start_id: "m2", model_usage: { input_tokens: 2000, output_tokens: 80 } } }),
    stored(11, 2600, { type: "agent.custom_tool_use", id: "c3", name: "deploy", input: { environment: "staging" } }),
    stored(12, 3000, { type: "user.custom_tool_result", custom_tool_use_id: "c3", content: [{ type: "text", text: "ok" }] }),
    stored(13, 3100, { type: "agent.message", id: "a1", content: [{ type: "text", text: "Fixed it." }] }),
    stored(14, 3200, { type: "session.status_idle" }),
  ];
}

describe("projectTrajectory", () => {
  it("pairs tool_use with results by call id across sources", () => {
    const p = projectTrajectory(sampleRun());
    const tools = p.steps.filter((s) => s.kind === "tool");
    expect(tools.map((t) => [t.toolName, t.toolSource, t.output, t.isError, t.durationMs])).toEqual([
      ["read", "builtin", "file body", false, 300],
      ["search", "mcp", "not found", true, 500],
      ["deploy", "custom", "ok", false, 400],
    ]);
    expect(tools[1]!.mcpServer).toBe("gh");
    expect(tools[0]!.events.map((e) => e.seq)).toEqual([5, 7]);
    expect(tools.every((t) => !t.pending)).toBe(true);
  });

  it("derives question, answer, turns, tokens and time bounds", () => {
    const p = projectTrajectory(sampleRun());
    expect(p.question).toBe("Fix the bug");
    expect(p.answer).toBe("Fixed it.");
    expect(p.startMs).toBe(T0);
    expect(p.endMs).toBe(T0 + 3200);
    // The custom tool result hands control back to the model → third turn.
    expect(p.turns.map((t) => t.trigger)).toEqual(["user", "tool_results", "tool_results"]);
    const [t1, t2, t3] = p.turns;
    expect(t1).toMatchObject({ toolCalls: 2, errors: 1, modelRequests: 1, inputTokens: 1000, outputTokens: 50, isFinal: false });
    expect(t2).toMatchObject({ toolCalls: 1, errors: 0, modelRequests: 1, inputTokens: 2000, outputTokens: 80, isFinal: false });
    expect(t3).toMatchObject({ toolCalls: 0, messages: 1, isFinal: true });
    expect(t1!.durationMs).toBe(1600);
    expect(t2!.durationMs).toBe(1300);
    expect(t3!.endMs).toBe(T0 + 3200);
    expect(p.modelSpans).toHaveLength(2);
    expect(p.modelSpans[1]).toMatchObject({ turn: 1, endMs: T0 + 2500, outputTokens: 80 });
  });

  it("starts a new turn when the model resumes after tool results without spans", () => {
    const p = projectTrajectory([
      { type: "agent.tool_use", id: "x", name: "bash", input: { command: "ls" } },
      { type: "agent.tool_result", tool_use_id: "x", content: "a" },
      { type: "agent.message", content: "done" },
    ]);
    expect(p.turns.map((t) => t.trigger)).toEqual(["start", "tool_results"]);
    expect(p.steps.map((s) => s.turn)).toEqual([0, 1]);
  });

  it("starts a new turn per model request once the current one produced output", () => {
    const p = projectTrajectory([
      { type: "span.model_request_start", id: "a" },
      { type: "agent.message", text: "one" },
      { type: "span.model_request_start", id: "b" },
      { type: "agent.message", text: "two" },
    ]);
    expect(p.turns.map((t) => t.trigger)).toEqual(["start", "model_request"]);
    expect(p.modelSpans).toEqual([]); // untimed spans are not drawn
  });

  it("opens a tool_results turn on a model request after results", () => {
    const p = projectTrajectory([
      { type: "agent.tool_use", id: "x", name: "read", input: {} },
      { type: "agent.tool_result", tool_use_id: "x", content: "a" },
      { type: "span.model_request_start", id: "b", ts: iso(10) },
      { type: "span.model_request_end", ts: iso(20), model_usage: { input_tokens: 5, output_tokens: 1 } },
    ]);
    expect(p.turns.map((t) => t.trigger)).toEqual(["start", "tool_results"]);
    // FIFO pairing when the end has no start id.
    expect(p.modelSpans[0]).toMatchObject({ endMs: T0 + 20, inputTokens: 5 });
  });

  it("keeps orphan results and pending calls visible", () => {
    const p = projectTrajectory([
      { type: "agent.tool_result", tool_use_id: "ghost", content: "late" },
      { type: "agent.tool_use", id: "y", name: "read", input: { path: "/x" } },
      { type: "agent.tool_result", content: "" },
    ]);
    const [orphan, pending, anon] = p.steps;
    expect(orphan).toMatchObject({ orphan: true, callId: "ghost", output: "late", summary: "late" });
    expect(pending).toMatchObject({ pending: true, summary: "/x", endMs: null });
    expect(anon).toMatchObject({ orphan: true, summary: "(orphan tool result)" });
  });

  it("projects errors, outcomes, interrupts and terminations", () => {
    const p = projectTrajectory([
      { type: "session.error", error: { message: "boom" } },
      { type: "session.error" },
      { type: "session.outcome_evaluated", result: "failed", explanation: "tests fail" },
      { type: "session.outcome_evaluated" },
      { type: "user.interrupt" },
      { type: "session.status_terminated", reason: "budget" },
      { type: "session.status_terminated" },
      { type: "agent.message", content: [] },
      { type: "agent.thinking" },
      { type: "user.message", content: "" },
    ]);
    expect(p.steps.map((s) => [s.kind, s.summary])).toEqual([
      ["error", "boom"],
      ["error", "Session error"],
      ["outcome", "failed — tests fail"],
      ["outcome", "evaluated"],
      ["status", "User interrupted the run"],
      ["status", "budget"],
      ["status", "Session terminated"],
      ["assistant", "(empty message)"],
      ["thinking", "(redacted thinking)"],
      ["user", "(empty message)"],
    ]);
    expect(p.steps[2]!.isError).toBe(true);
    expect(p.turns[0]!.errors).toBe(3);
    expect(p.startMs).toBeNull();
  });

  it("returns an empty projection for no events", () => {
    const p = projectTrajectory([]);
    expect(p).toMatchObject({ steps: [], turns: [], question: null, answer: null, startMs: null });
    expect(projectTrajectory(undefined).steps).toEqual([]);
  });

  it("ignores model ends with nothing open and ids for stepIds", () => {
    const p = projectTrajectory([
      { type: "span.model_request_end", model_usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "agent.message", id: "same", text: "a" },
    ]);
    expect(p.steps[0]!.id).toBe("agent.message:same");
    expect(p.modelSpans).toEqual([]);
  });
});

function tool(id: string, name: string, extra: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return {
    id, kind: "tool", turn: 0, label: name, summary: id, startMs: null, endMs: null,
    durationMs: null, toolName: name, events: [], ...extra,
  };
}
function msg(id: string): TrajectoryStep {
  return { id, kind: "assistant", turn: 0, label: "Assistant", summary: id, text: id, startMs: null, endMs: null, durationMs: null, events: [] };
}

describe("groupSteps", () => {
  it(`folds ${MIN_GROUP_SIZE}+ consecutive same-tool calls`, () => {
    const rows = groupSteps([
      tool("r1", "read", { startMs: 10, endMs: 20 }),
      tool("r2", "read", { startMs: 30, endMs: 40, isError: true }),
      tool("r3", "read", { startMs: 50 }),
      msg("m"),
    ]);
    expect(rows).toHaveLength(2);
    const g = rows[0]!;
    expect(isGroupRow(g)).toBe(true);
    if (!isGroupRow(g)) throw new Error("expected group");
    expect(g).toMatchObject({ toolName: "read", startMs: 10, endMs: 50, errors: 1, id: "group:r1" });
    expect(isGroupRow(rows[1]!)).toBe(false);
  });

  it("never folds shell calls, short runs, mixed tools or orphans", () => {
    const shell = groupSteps([tool("b1", "bash"), tool("b2", "bash"), tool("b3", "bash")]);
    expect(shell.every((r) => !isGroupRow(r))).toBe(true);
    expect(groupSteps([tool("a", "read"), tool("b", "read"), tool("c", "grep")]).some(isGroupRow)).toBe(false);
    expect(groupSteps([tool("a", "read"), tool("b", "read", { orphan: true }), tool("c", "read")]).some(isGroupRow)).toBe(false);
    const untimed = groupSteps([tool("a", "glob"), tool("b", "glob"), tool("c", "glob"), tool("d", "glob")]);
    expect(untimed).toHaveLength(1);
    expect(untimed[0]).toMatchObject({ startMs: null, endMs: null });
  });
});

describe("filters", () => {
  const p = projectTrajectory(sampleRun());
  const kinds = (ks: StepFilterKind[]) => ({ ...EMPTY_FILTER, kinds: new Set(ks) });

  it("empty filter keeps everything", () => {
    expect(filterSteps(p.steps, EMPTY_FILTER)).toHaveLength(p.steps.length);
  });

  it("filters by kind, with errors matching failed tool calls", () => {
    expect(filterSteps(p.steps, kinds(["user"])).map((s) => s.kind)).toEqual(["user"]);
    expect(filterSteps(p.steps, kinds(["tool"]))).toHaveLength(3);
    expect(filterSteps(p.steps, kinds(["error"])).map((s) => s.toolName)).toEqual(["search"]);
    expect(filterSteps(p.steps, kinds(["assistant", "thinking"]))).toHaveLength(2);
  });

  it("filters by tool and by text search over input/output", () => {
    expect(filterSteps(p.steps, { ...EMPTY_FILTER, tool: "read" }).map((s) => s.id)).toEqual(["agent.tool_use:c1"]);
    expect(filterSteps(p.steps, { ...EMPTY_FILTER, query: "FILE BODY" })).toHaveLength(1);
    expect(filterSteps(p.steps, { ...EMPTY_FILTER, query: "staging" })[0]!.toolName).toBe("deploy");
    expect(filterSteps(p.steps, { ...EMPTY_FILTER, query: "zzz" })).toEqual([]);
  });

  it("buckets outcome/status rows only when they failed", () => {
    const q = projectTrajectory([
      { type: "session.outcome_evaluated", result: "satisfied" },
      { type: "session.outcome_evaluated", result: "failed" },
      { type: "agent.tool_use", id: "s", name: "read", input: "raw string input" },
    ]);
    expect(stepFilterKind(q.steps[0]!)).toBeNull();
    expect(stepFilterKind(q.steps[1]!)).toBe("error");
    expect(filterSteps(q.steps, kinds(["user"]))).toEqual([]);
    expect(filterSteps(q.steps, { ...EMPTY_FILTER, query: "raw string" })).toHaveLength(1);
  });

  it("toolCounts sorts by count then name", () => {
    expect(toolCounts([tool("1", "b"), tool("2", "a"), tool("3", "b"), msg("m")])).toEqual([
      { name: "b", count: 2 },
      { name: "a", count: 1 },
    ]);
  });
});

describe("buildLanes", () => {
  it("returns null for untimed or very short runs", () => {
    expect(buildLanes(projectTrajectory([{ type: "agent.message", text: "x" }]))).toBeNull();
    expect(buildLanes(projectTrajectory([
      { type: "agent.message", text: "x", ts: iso(0) },
      { type: "agent.message", text: "y", ts: iso(200) },
    ]))).toBeNull();
  });

  it("uses model spans + tool calls when spans exist", () => {
    const lanes = buildLanes(projectTrajectory(sampleRun()))!;
    expect(lanes.totalMs).toBe(3200);
    const model = lanes.segments.filter((s) => s.lane === "model");
    const tools = lanes.segments.filter((s) => s.lane === "tools");
    expect(model.map((m) => [m.startMs, m.endMs, m.tone])).toEqual([[100, 900, "ok"], [1700, 2500, "ok"]]);
    expect(model[0]!.stepId).toBe("user.message:u1");
    expect(tools.map((t) => t.tone)).toEqual(["ok", "error", "ok"]);
  });

  it("falls back to message markers and marks pending/error segments", () => {
    const p = projectTrajectory([
      { type: "user.message", text: "go", ts: iso(0) },
      { type: "agent.tool_use", id: "p", name: "bash", input: { command: "sleep" }, ts: iso(500) },
      { type: "session.error", message: "bad", ts: iso(1500) },
      { type: "agent.message", ts: iso(2000) },
      { type: "span.model_request_start", id: "open", ts: iso(2100) },
      { type: "span.model_request_end", is_error: true, model_request_start_id: "open", ts: iso(2200) },
    ]);
    const lanes = buildLanes(p)!;
    const tools = lanes.segments.filter((s) => s.lane === "tools");
    expect(tools[0]).toMatchObject({ tone: "pending", startMs: 500, endMs: 2200 });
    const model = lanes.segments.filter((s) => s.lane === "model");
    expect(model.some((s) => s.tone === "error" && s.label.startsWith("Model request"))).toBe(true);
    expect(model.some((s) => s.tone === "error" && s.label.startsWith("Error"))).toBe(true);
  });

  it("draws markers for messages without model spans and skips untimed steps", () => {
    const lanes = buildLanes(projectTrajectory([
      { type: "user.message", text: "go", ts: iso(0) },
      { type: "agent.message", text: "no time" },
      { type: "agent.tool_result", tool_use_id: "o", content: "x", ts: iso(1500) },
      { type: "span.model_request_start", id: "z", ts: iso(1600) },
    ]))!;
    // An open model span is pending until run end.
    expect(lanes.segments.find((s) => s.label === "Model request 1")).toMatchObject({ tone: "pending", endMs: 1600 });
    expect(lanes.segments.filter((s) => s.lane === "tools")[0]).toMatchObject({ startMs: 1500, endMs: 1500 });
  });

  it("segmentPosition clamps and enforces a minimum width", () => {
    const seg = { lane: "tools" as const, stepId: "s", turn: 0, startMs: 0, endMs: 0, tone: "ok" as const, label: "" };
    expect(segmentPosition(seg, 1000)).toEqual({ left: 0, width: 0.6 });
    expect(segmentPosition({ ...seg, startMs: 500, endMs: 750 }, 1000)).toEqual({ left: 50, width: 25 });
    expect(segmentPosition({ ...seg, startMs: 1000, endMs: 1000 }, 1000)).toEqual({ left: 100, width: 0 });
  });
});

describe("transcriptText", () => {
  it("renders turns, messages and tool input/output", () => {
    const text = transcriptText(projectTrajectory(sampleRun()).steps);
    expect(text).toContain("## Turn 1");
    expect(text).toContain("## Turn 3");
    expect(text).toContain("[user] Fix the bug");
    expect(text).toContain("[thinking] Look at files");
    expect(text).toContain("[tool search · error · 500ms]");
    expect(text).toContain('"file_path": "/a.ts"');
    expect(text).toContain("output: file body");
    expect(text).toContain("[assistant] Fixed it.");
  });

  it("marks pending calls and handles string / missing inputs", () => {
    const text = transcriptText([
      tool("p", "read", { pending: true, input: "raw" }),
      tool("q", "grep", { output: "" }),
      { ...msg("e"), kind: "error", label: "Error", text: undefined, summary: "boom" },
    ]);
    expect(text).toContain("[tool read · pending]\ninput: raw");
    expect(text).toContain("[tool grep]\noutput: ");
    expect(text).toContain("[error] boom");
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
