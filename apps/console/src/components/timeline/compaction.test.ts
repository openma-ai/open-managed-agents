import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  buildTimeScale,
  buildTrace,
  clampScroll,
  filterSteps,
  hiddenLifecycleCount,
  layoutOverview,
  stepFilterKind,
  viewportForRange,
  visibleWallRange,
  wallTicks,
  zoomAround,
  type StepFilterKind,
} from "../../lib/trajectory-steps";
import { deriveTraceSteps } from "./derive";
import type { Event } from "../../lib/events";

const T0 = Date.parse("2026-11-07T00:00:00Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const ev = (ms: number, e: Record<string, unknown>): Event => ({ ...e, ts: iso(ms) }) as Event;
const stored = (seq: number, ms: number, e: Record<string, unknown>) => ({ seq, type: e.type, data: JSON.stringify(e), ts: iso(ms) });

const USAGE = { input_tokens: 5000, output_tokens: 300, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 };

function compactionRun() {
  return [
    stored(1, 0, { type: "user.message", content: [{ type: "text", text: "go" }] }),
    stored(2, 100, { type: "span.model_request_start", id: "m1" }),
    stored(3, 900, { type: "span.model_request_end", model_request_start_id: "m1", model_usage: { input_tokens: 1000, output_tokens: 50 } }),
    stored(4, 1_000, { type: "span.compaction_summarize_start", model: "summarizer" }),
    stored(5, 3_000, { type: "span.compaction_summarize_end", model: "summarizer", model_usage: USAGE, finish_reason: "stop", final_text_length: 812 }),
    stored(6, 3_010, {
      type: "agent.thread_context_compacted",
      summary: [{ type: "text", text: "User wants the checkout bug fixed.\nTests read." }],
      original_message_count: 42,
      compacted_message_count: 1,
      trigger: "auto",
      pre_tokens: 91_000,
      replaced_range: { start_seq: 1, end_seq: 5 },
    }),
    stored(7, 3_020, { type: "session.warning", source: "oma.context_reassembled", message: "Context re-assembled after compaction", details: { inlinedSkillIds: [] } }),
    stored(8, 3_500, { type: "session.status_idle" }),
  ];
}

describe("compaction — derive", () => {
  it("pairs summarize start/end into one span carrying only reported fields", () => {
    const p = buildTrace(compactionRun());
    const span = p.steps.find((s) => s.compaction?.role === "summarize")!;
    expect(span).toMatchObject({
      family: "compaction",
      kind: "lifecycle",
      label: "compaction",
      startTs: T0 + 1_000,
      endTs: T0 + 3_000,
      durationMs: 2_000,
      instant: false,
      pending: false,
      model: "summarizer",
      usage: USAGE,
      finishReason: "stop",
      compaction: { role: "summarize", finalTextLength: 812 },
    });
    // Real event names stay on the step.
    expect(span.events.map((e) => e.type)).toEqual(["span.compaction_summarize_start", "span.compaction_summarize_end"]);
  });

  it("copies boundary fields from agent.thread_context_compacted", () => {
    const p = buildTrace(compactionRun());
    const b = p.steps.find((s) => s.compaction?.role === "boundary")!;
    expect(b).toMatchObject({ family: "compaction", instant: true, label: "thread compacted", startTs: T0 + 3_010 });
    expect(b.compaction).toEqual({
      role: "boundary",
      summary: "User wants the checkout bug fixed.\nTests read.",
      originalMessageCount: 42,
      compactedMessageCount: 1,
      trigger: "auto",
      preTokens: 91_000,
      replacedRange: { startSeq: 1, endSeq: 5 },
    });
    expect(b.detail).toBe("42 → 1 messages · auto · User wants the checkout bug fixed.");
    expect(b.events[0]!.type).toBe("agent.thread_context_compacted");
  });

  it("keeps missing boundary / summarize fields absent — never invented", () => {
    const steps = deriveTraceSteps([
      ev(0, { type: "span.compaction_summarize_start" }),
      ev(10, { type: "span.compaction_summarize_end" }),
      ev(20, { type: "agent.thread_context_compacted" }),
      ev(30, { type: "span.compaction_summarize_end", model_usage: { input_tokens: "lots" } }),
    ]);
    const span = steps.find((s) => s.compaction?.role === "summarize")!;
    expect(span.model).toBeUndefined();
    expect(span.usage).toBeUndefined();
    expect(span.finishReason).toBeUndefined();
    expect(span.compaction).toEqual({ role: "summarize" });
    expect(span.detail).toBeUndefined();
    const b = steps.find((s) => s.compaction?.role === "boundary")!;
    expect(b.compaction).toEqual({ role: "boundary" });
    expect(b.text).toBeUndefined();
    expect(b.detail).toBeUndefined();
    // Malformed usage is not reported usage.
    expect(steps.find((s) => s.compaction?.role === "orphan_end")!.usage).toBeUndefined();
  });

  it("surfaces an unpaired summarize_end as an orphan marker instead of dropping it", () => {
    const steps = deriveTraceSteps([
      ev(0, { type: "span.compaction_summarize_end", model_usage: { input_tokens: 10, output_tokens: 2 }, finish_reason: "stop" }),
      ev(10, { type: "span.compaction_summarize_start" }),
      ev(20, { type: "span.compaction_summarize_end" }),
    ]);
    expect(steps.map((s) => [s.compaction?.role, s.orphan, s.instant])).toEqual([
      ["orphan_end", true, true],
      ["summarize", false, false],
    ]);
    // The end that came before the start was not paired with it.
    expect(steps[1]!.endTs).toBe(T0 + 20);
    expect(steps[0]!.label).toBe("compaction end (no matching start)");
    expect(steps[0]!.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
  });

  it("an unpaired start stays pending with unknown duration; untimed stays null", () => {
    const steps = deriveTraceSteps([
      ev(0, { type: "span.compaction_summarize_start" }),
      { type: "agent.thread_context_compacted", summary: [{ type: "text", text: "s" }] } as Event,
    ]);
    expect(steps[0]).toMatchObject({ pending: true, endTs: null, durationMs: null });
    expect(steps[1]).toMatchObject({ startTs: null, instant: true });
  });

  it("flags a summarize that reported finish_reason error", () => {
    const steps = deriveTraceSteps([
      ev(0, { type: "span.compaction_summarize_start" }),
      ev(5, { type: "span.compaction_summarize_end", finish_reason: "error", final_text_length: 0 }),
    ]);
    expect(steps[0]).toMatchObject({ isError: true, compaction: { role: "summarize", finalTextLength: 0 } });
  });

  it("keeps the re-assembly marker a session.warning with its real source", () => {
    const p = buildTrace(compactionRun());
    const w = p.steps.find((s) => s.family === "warn")!;
    expect(w.label).toBe("warning:oma.context_reassembled");
    expect(w.detail).toBe("Context re-assembled after compaction");
    expect(w.compaction).toBeUndefined();
    expect(w.instant).toBe(true);
  });

  it("attributes summarize usage separately from generation tokens and models", () => {
    const p = buildTrace(compactionRun());
    expect(p.tokens).toMatchObject({ input: 1000, output: 50, calls: 1 });
    expect(p.compactionTokens).toMatchObject({ input: 5000, output: 300, cacheRead: 4000, calls: 1 });
    expect(p.models).toEqual([]);
    expect(p.turns[0]!.tokens).toMatchObject({ input: 1000, output: 50 });
  });

  it("compactionTokens stays null when no summarize usage was reported", () => {
    const p = buildTrace([stored(1, 0, { type: "user.message", text: "x" }), stored(2, 10, { type: "agent.thread_context_compacted" })]);
    expect(p.compactionTokens).toBeNull();
  });
});

describe("compaction — filters", () => {
  const p = buildTrace(compactionRun());
  const kinds = (ks: StepFilterKind[]) => ({ ...EMPTY_FILTER, kinds: new Set(ks) });

  it("has its own filter bucket including the re-assembly warning", () => {
    expect(p.steps.filter((s) => stepFilterKind(s) === "compaction").map((s) => s.label)).toEqual([
      "compaction",
      "thread compacted",
      "warning:oma.context_reassembled",
    ]);
    expect(filterSteps(p.steps, kinds(["compaction"]))).toHaveLength(3);
    // Generation filter doesn't pick up compaction usage.
    expect(filterSteps(p.steps, kinds(["model"])).map((s) => s.kind)).toEqual(["model"]);
  });

  it("counts lifecycle markers hidden by a kind filter, and none without one", () => {
    expect(hiddenLifecycleCount(p.steps, EMPTY_FILTER)).toBe(0);
    // status_idle is hidden by the Generation filter; compaction steps have a bucket.
    expect(hiddenLifecycleCount(p.steps, kinds(["model"]))).toBe(1);
  });

  it("errors stay visible under the Errors filter", () => {
    const q = buildTrace([
      stored(1, 0, { type: "user.message", text: "x" }),
      stored(2, 10, { type: "span.compaction_summarize_start" }),
      stored(3, 20, { type: "span.compaction_summarize_end", finish_reason: "error" }),
    ]);
    expect(filterSteps(q.steps, kinds(["error"])).map((s) => s.label)).toEqual(["compaction"]);
  });
});

describe("compaction — overview layout", () => {
  it("draws the summarize span as a bar and the boundary as a compaction marker", () => {
    const p = buildTrace(compactionRun());
    const layout = layoutOverview(p, buildTimeScale(p.startTs!, p.endTs!));
    const bar = layout.stepBars.find((b) => b.step.family === "compaction")!;
    expect([bar.d0, bar.d1]).toEqual([1_000, 3_000]);
    expect(layout.markers.map((m) => [m.kind, m.step.label])).toEqual([
      ["user", "user.message"],
      ["compaction", "thread compacted"],
    ]);
  });

  it("keeps orphan ends as markers and untimed compaction off the overview", () => {
    const p = buildTrace([
      stored(1, 0, { type: "user.message", text: "x" }),
      stored(2, 10, { type: "span.compaction_summarize_end" }),
      { seq: 3, type: "agent.thread_context_compacted", data: JSON.stringify({ type: "agent.thread_context_compacted" }) },
      stored(4, 20, { type: "session.status_idle" }),
    ]);
    const layout = layoutOverview(p, buildTimeScale(p.startTs!, p.endTs!));
    const comp = layout.markers.filter((m) => m.kind === "compaction");
    expect(comp.map((m) => m.step.orphan)).toEqual([true]);
    expect(p.steps.find((s) => s.compaction?.role === "boundary")!.startTs).toBeNull();
  });
});

describe("viewport helpers", () => {
  const b = { total: 10_000, viewportPx: 1000, maxPxPerMs: 64_000 / 10_000 };

  it("fits a range and clamps at the session start and end", () => {
    const mid = viewportForRange(2_000, 4_000, b);
    expect(mid.pxPerMs).toBeCloseTo(0.5);
    expect(mid.scrollLeft).toBeCloseTo(1_000);
    const atStart = viewportForRange(-500, 1_000, b);
    expect(atStart.scrollLeft).toBe(0);
    const atEnd = viewportForRange(9_000, 12_000, b);
    expect(atEnd.pxPerMs).toBeCloseTo(1);
    expect(atEnd.scrollLeft).toBeCloseTo(10_000 * 1 - 1000);
    // Never zooms out past fit or scrolls beyond the chart.
    const whole = viewportForRange(0, 10_000, b);
    expect(whole).toEqual({ pxPerMs: 0.1, scrollLeft: 0 });
  });

  it("widens a zero-length (instant) range instead of dividing by zero", () => {
    const v = viewportForRange(10_000, 10_000, b);
    expect(Number.isFinite(v.pxPerMs)).toBe(true);
    expect(v.pxPerMs).toBeLessThanOrEqual(b.maxPxPerMs);
    expect(v.scrollLeft).toBeCloseTo(clampScroll(Infinity, v.pxPerMs, b));
  });

  it("zoomAround keeps the centre and stays within [fit, max]", () => {
    const z = zoomAround(5_000, 0.1, 2, b);
    expect(z.pxPerMs).toBeCloseTo(0.2);
    expect(z.scrollLeft + b.viewportPx / 2).toBeCloseTo(5_000 * 0.2);
    expect(zoomAround(5_000, 0.1, 0.5, b).pxPerMs).toBeCloseTo(0.1);
    expect(zoomAround(5_000, 6, 4, b).pxPerMs).toBeCloseTo(6.4);
    // Zoom at the very end clamps the scroll.
    const end = zoomAround(10_000, 0.1, 4, b);
    expect(end.scrollLeft).toBeCloseTo(10_000 * 0.4 - 1000);
  });

  it("visible window reports real wall-clock times across a collapsed gap", () => {
    const s = buildTimeScale(0, 3_602_000, [{ key: "g", startTs: 1000, endTs: 3_601_000 }]);
    const w = visibleWallRange(s, { pxPerMs: 1000 / s.total, scrollLeft: 0 }, 1000);
    expect(w.startTs).toBe(0);
    expect(w.endTs).toBeCloseTo(3_602_000);
  });

  it("ticks around a collapsed 1h gap label real timestamps on both sides", () => {
    const H = 3_600_000;
    const s = buildTimeScale(T0, T0 + H + 20_000, [{ key: "g", startTs: T0 + 10_000, endTs: T0 + H + 10_000 }]);
    const pxPerMs = 1000 / s.total;
    const { ticks } = wallTicks(s, 0, s.total, pxPerMs);
    const before = ticks.filter((t) => t.ts <= T0 + 10_000);
    const after = ticks.filter((t) => t.ts >= T0 + H + 10_000);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    // No tick falls inside the collapsed interval; display order matches wall order.
    expect(ticks.every((t) => t.ts <= T0 + 10_000 || t.ts >= T0 + H + 10_000)).toBe(true);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.d).toBeGreaterThan(ticks[i - 1]!.d);
    expect(after[0]!.d).toBeLessThan(s.total);
  });
});
