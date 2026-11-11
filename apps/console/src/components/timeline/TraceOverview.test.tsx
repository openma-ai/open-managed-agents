import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Event } from "../../lib/events";
import { TraceView } from "./TraceView";

const T0 = Date.parse("2026-11-07T00:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const ev = (ms: number, e: Record<string, unknown>): Event => ({ ...e, ts: iso(ms) }) as Event;

const details = () => screen.getByRole("complementary", { name: "Event details" });
const tree = () => screen.getByRole("tree", { name: "Trace tree" });
const chart = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-overview-chart]")!;

function compactionEvents(): Event[] {
  return [
    ev(0, { type: "user.message", content: [{ type: "text", text: "go" }] }),
    ev(100, { type: "span.model_request_start", id: "m1" }),
    ev(900, { type: "span.model_request_end", model_request_start_id: "m1", model_usage: { input_tokens: 1000, output_tokens: 50 } }),
    ev(1_000, { type: "span.compaction_summarize_start", model: "summarizer" }),
    ev(3_000, { type: "span.compaction_summarize_end", model: "summarizer", model_usage: { input_tokens: 5000, output_tokens: 300 }, finish_reason: "stop", final_text_length: 812 }),
    ev(3_010, { type: "agent.thread_context_compacted", summary: [{ type: "text", text: "Summary body" }], original_message_count: 42, compacted_message_count: 1, trigger: "auto", pre_tokens: 91000 }),
    ev(3_020, { type: "session.warning", source: "oma.context_reassembled", message: "Context re-assembled after compaction" }),
    ev(3_030, { type: "span.compaction_summarize_end" }),
    ev(3_500, { type: "session.status_idle" }),
  ];
}

/** Turn 1 (1s), 1h idle, turn 2 (1s), 0-length handoff to turn 3. */
function hourIdle(): Event[] {
  return [
    ev(0, { type: "user.message", text: "a" }),
    ev(100, { type: "agent.tool_use", id: "t1", name: "read", input: { file_path: "/a" } }),
    ev(600, { type: "agent.tool_result", tool_use_id: "t1", content: "A" }),
    ev(1_000, { type: "session.status_idle" }),
    ev(1_000 + H, { type: "user.message", text: "b" }),
    ev(1_200 + H, { type: "agent.tool_use", id: "t2", name: "bash", input: { command: "ls" } }),
    ev(1_800 + H, { type: "agent.tool_result", tool_use_id: "t2", content: "ok" }),
    ev(2_000 + H, { type: "session.status_idle" }),
    // Next trigger at the exact close time: zero-length gap, no idle.
    ev(2_000 + H, { type: "user.message", text: "c" }),
    ev(2_500 + H, { type: "agent.message", text: "done" }),
    ev(3_000 + H, { type: "session.status_idle" }),
  ];
}

describe("Trace compaction UI", () => {
  it("shows the summarize span, the boundary marker and the reassembly warning distinctly", () => {
    const { container } = render(<TraceView events={compactionEvents()} />);
    expect(container.querySelector('[data-step-bar="compaction"]')).not.toBeNull();
    const markers = container.querySelectorAll('[data-marker="compaction"]');
    expect(markers).toHaveLength(2);
    expect(container.querySelector('[data-marker="compaction"][data-orphan="true"]')).not.toBeNull();
    // Not drawn like user / error / wakeup markers.
    expect(container.querySelectorAll('[data-marker="user"]')).toHaveLength(1);
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getByText("Compaction")).toBeInTheDocument();
    expect(within(legend).getByText("Context boundary")).toBeInTheDocument();
    expect(within(tree()).getByRole("treeitem", { name: /warning:oma\.context_reassembled/ })).toBeInTheDocument();
    expect(within(tree()).getByRole("treeitem", { name: /compaction end \(no matching start\)/ })).toHaveTextContent("unpaired");
    const summary = screen.getByRole("region", { name: "Trace summary" });
    expect(within(summary).getByText("Compactions").nextSibling).toHaveTextContent("1 boundary · 1 summarize · 1 unpaired end");
    expect(within(summary).getByText("Compaction tokens in / out").nextSibling).toHaveTextContent("5.0k / 300");
    expect(within(summary).getByText("Tokens in / out").nextSibling).toHaveTextContent("1.0k / 50");
  });

  it("inspects summarize usage and boundary fields with real event names", () => {
    render(<TraceView events={compactionEvents()} />);
    fireEvent.click(within(tree()).getByRole("treeitem", { name: /^compaction\s*stop/ }));
    let c = within(within(details()).getByTestId("compaction-details"));
    expect(c.getByText(/span\.compaction_summarize_start → span\.compaction_summarize_end/)).toBeInTheDocument();
    expect(c.getByText("Model").nextSibling).toHaveTextContent("summarizer");
    expect(c.getByText("Input tokens").nextSibling).toHaveTextContent("5000");
    expect(c.getByText("Finish reason").nextSibling).toHaveTextContent("stop");
    expect(c.getByText("Summary length").nextSibling).toHaveTextContent("812 chars");
    expect(within(details()).getByText("span.compaction_summarize_start, span.compaction_summarize_end")).toBeInTheDocument();

    fireEvent.click(within(tree()).getByRole("treeitem", { name: /thread compacted/ }));
    c = within(within(details()).getByTestId("compaction-details"));
    expect(c.getByText("Messages before").nextSibling).toHaveTextContent("42");
    expect(c.getByText("Messages after").nextSibling).toHaveTextContent("1");
    expect(c.getByText("Trigger").nextSibling).toHaveTextContent("auto");
    expect(c.getByText("Pre-compaction tokens").nextSibling).toHaveTextContent("91000");
    expect(c.queryByText("Replaced seq range")).toBeNull();
    expect(within(within(details()).getByRole("region", { name: "Summary" })).getByText("Summary body")).toBeInTheDocument();

    fireEvent.click(within(tree()).getByRole("treeitem", { name: /no matching start/ }));
    c = within(within(details()).getByTestId("compaction-details"));
    expect(c.getByText(/Unpaired span\.compaction_summarize_end/)).toBeInTheDocument();
    expect(c.getByText("Model").nextSibling).toHaveTextContent("not reported");
    expect(c.getByText("Usage").nextSibling).toHaveTextContent("not reported");

    fireEvent.click(within(tree()).getByRole("treeitem", { name: /context_reassembled/ }));
    const w = within(within(details()).getByRole("region", { name: "Warning" }));
    expect(w.getByText("Source").nextSibling).toHaveTextContent("oma.context_reassembled");
    expect(within(details()).queryByTestId("compaction-details")).toBeNull();
  });

  it("boundary without fields says not reported", () => {
    render(<TraceView events={[ev(0, { type: "user.message", text: "x" }), ev(10, { type: "agent.thread_context_compacted" })]} />);
    fireEvent.click(within(tree()).getByRole("treeitem", { name: /thread compacted/ }));
    const c = within(within(details()).getByTestId("compaction-details"));
    for (const k of ["Messages before", "Messages after", "Trigger", "Pre-compaction tokens"]) {
      expect(c.getByText(k).nextSibling).toHaveTextContent("not reported");
    }
    expect(within(details()).getByText("Summary not reported on this event.")).toBeInTheDocument();
  });

  it("has a Compaction filter and explains lifecycle rows hidden by kind filters", () => {
    render(<TraceView events={compactionEvents()} />);
    fireEvent.click(screen.getByRole("button", { name: "Compaction" }));
    expect(screen.getByText("4 of 7 steps")).toBeInTheDocument();
    expect(within(tree()).getByRole("treeitem", { name: /thread compacted/ })).toBeInTheDocument();
    expect(screen.getByTestId("hidden-lifecycle")).toHaveTextContent("1 lifecycle marker");
    fireEvent.click(screen.getByRole("button", { name: "Compaction" }));
    fireEvent.click(screen.getByRole("button", { name: "Generation" }));
    expect(within(tree()).queryByRole("treeitem", { name: /thread compacted/ })).toBeNull();
    expect(screen.getByTestId("hidden-lifecycle")).toBeInTheDocument();
  });

  it("hides the Compaction chip when the stream has no compaction", () => {
    render(<TraceView events={hourIdle()} />);
    expect(screen.queryByRole("button", { name: "Compaction" })).toBeNull();
    // The legend still explains the compaction colour.
    expect(within(screen.getByRole("list", { name: "Legend" })).getByText("Compaction")).toBeInTheDocument();
  });
});

describe("Trace overview gaps", () => {
  it("zero-length handoff produces no gap; 1h close→trigger is idle", () => {
    const { container } = render(<TraceView events={hourIdle()} />);
    const gaps = container.querySelectorAll("[data-gap-kind]");
    expect([...gaps].map((g) => g.getAttribute("data-gap-kind"))).toEqual(["idle"]);
    expect(gaps[0]).toHaveTextContent("60m0s idle");
  });

  it("missing endedAt or trigger time is unknown, never idle", () => {
    const { container } = render(
      <TraceView
        events={[
          ev(0, { type: "user.message", text: "a" }),
          ev(500, { type: "agent.message", text: "no close" }),
          ev(H, { type: "user.message", text: "b" }),
          ev(H + 10, { type: "session.status_idle" }),
          { type: "user.message", text: "untimed trigger" } as Event,
        ]}
      />,
    );
    const kinds = [...container.querySelectorAll("[data-gap-kind]")].map((g) => g.getAttribute("data-gap-kind"));
    expect(kinds).toEqual(["unknown", "unknown"]);
    expect(container.querySelector("[data-gap-kind]")).toHaveTextContent("not classified as idle");
    expect(screen.queryByRole("button", { name: "Collapse idle gaps" })).toBeNull();
    expect([...container.querySelectorAll("[data-gap-bar]")].map((b) => b.getAttribute("data-gap-bar"))).toEqual(["unknown"]);
  });
});

describe("Trace overview selection, range, reset and fit", () => {
  function mockRect(c: HTMLElement) {
    vi.spyOn(chart(c), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  }

  it("1h idle: collapse, select, fit, reset, restore — durations kept", () => {
    const { container } = render(<TraceView events={hourIdle()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to full session" }));
    const fullPx = Number(chart(container).dataset.chartPx);
    expect(screen.getByTestId("overview-window")).toHaveTextContent("60m3s wall clock");

    fireEvent.click(screen.getByRole("button", { name: "Collapse 60m0s idle gap" }));
    // Axis break keeps the true duration; full-session view still spans the real wall clock.
    expect(container.querySelector("[data-axis-break]")).toHaveTextContent("60m0s");
    expect(screen.getByTestId("overview-collapsed")).toHaveTextContent("1 idle gap collapsed · 60m0s kept on markers");
    expect(screen.getByTestId("overview-window")).toHaveTextContent("60m3s wall clock");
    // Ticks still label real times after the gap.
    const ticks = [...container.querySelectorAll<HTMLElement>("[data-tick]")].map((t) => Number(t.dataset.tick));
    expect(ticks.some((t) => t >= T0 + H)).toBe(true);
    expect(ticks.every((t) => t <= T0 + 1_000 || t >= T0 + 1_000 + H)).toBe(true);

    // Select a step in turn 2 after collapsing: selection + overlay stay valid.
    fireEvent.click(screen.getByRole("button", { name: "Select bash: ls" }));
    expect(within(details()).getByTestId("inspector-header")).toHaveTextContent("bash");
    expect(screen.getByTestId("overview-selection")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fit selection" }));
    expect(chart(container).dataset.zoomMode).toBe("manual");
    expect(Number(chart(container).dataset.chartPx)).toBeGreaterThan(fullPx);
    expect(screen.getByTestId("overview-window")).not.toHaveTextContent("60m");

    // Reset → full session again, gap still collapsed, selection kept.
    fireEvent.click(screen.getByRole("button", { name: "Reset to full session" }));
    expect(chart(container).dataset.zoomMode).toBe("fit");
    expect(chart(container).dataset.scrollLeft).toBe("0");
    expect(container.querySelector("[data-gap-bar]")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("overview-window")).toHaveTextContent("60m3s wall clock");
    expect(within(details()).getByTestId("inspector-header")).toHaveTextContent("bash");

    // Restore the gap: still the same wall-clock span.
    fireEvent.click(screen.getByRole("button", { name: "Restore idle gaps" }));
    expect(container.querySelector("[data-axis-break]")).toBeNull();
    expect(screen.getByTestId("overview-window")).toHaveTextContent("60m3s wall clock");
  });

  it("brush selects a range without clobbering the selected event; Reset clears only the range", () => {
    const { container } = render(<TraceView events={hourIdle()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to full session" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Turn 3" }));
    mockRect(container);
    fireEvent.mouseDown(chart(container), { button: 0, clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 700 });
    fireEvent.mouseUp(window, { clientX: 700 });
    expect(screen.getByTestId("overview-range")).toBeInTheDocument();
    expect(screen.getByTestId("overview-range-chip")).toHaveTextContent(/^Range /);
    expect(chart(container).dataset.zoomMode).toBe("manual");
    // The event selection survives the brush.
    expect(within(tree()).getByRole("treeitem", { name: /Turn 3/ })).toHaveAttribute("aria-selected", "true");

    // A plain click (no drag) on empty chart space changes nothing.
    const px = chart(container).dataset.chartPx;
    fireEvent.mouseDown(chart(container), { button: 0, clientX: 50 });
    fireEvent.mouseUp(window, { clientX: 51 });
    expect(chart(container).dataset.chartPx).toBe(px);
    expect(screen.getByTestId("overview-range")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset to full session" }));
    expect(screen.queryByTestId("overview-range")).toBeNull();
    expect(within(tree()).getByRole("treeitem", { name: /Turn 3/ })).toHaveAttribute("aria-selected", "true");
  });

  it("Fit selection falls back to the brushed range when nothing is selected", () => {
    const { container } = render(<TraceView events={hourIdle()} />);
    expect(screen.getByRole("button", { name: "Fit selection" })).toBeDisabled();
    mockRect(container);
    fireEvent.mouseDown(chart(container), { button: 0, clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 300 });
    const zoomed = chart(container).dataset.chartPx;
    // Leave the range view without clearing it (auto density keeps the range).
    fireEvent.click(screen.getByRole("button", { name: "Auto-pick scale by event density" }));
    expect(screen.getByTestId("overview-range-chip")).toBeInTheDocument();
    const fitBtn = screen.getByRole("button", { name: "Fit selection" });
    expect(fitBtn).toBeEnabled();
    expect(fitBtn).toHaveAccessibleDescription("Zooms to the brushed range");
    fireEvent.click(fitBtn);
    expect(chart(container).dataset.chartPx).toBe(zoomed);
    fireEvent.click(screen.getByRole("button", { name: "Clear brushed range" }));
    expect(screen.getByRole("button", { name: "Fit selection" })).toBeDisabled();
  });

  it("zoom stays within session bounds: − disabled at full session, scroll clamps at the end", () => {
    const { container } = render(<TraceView events={hourIdle()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to full session" }));
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    // Select the last event and fit: viewport ends at the session end, not beyond.
    fireEvent.click(within(tree()).getByRole("treeitem", { name: /agent\.message/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fit selection" }));
    const c = chart(container);
    expect(Number(c.dataset.scrollLeft)).toBeLessThanOrEqual(Number(c.dataset.chartPx) - 800 + 1);
    expect(screen.getByTestId("overview-mode")).toHaveTextContent("× zoom");
    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    expect(Number(c.dataset.chartPx)).toBeLessThanOrEqual(64_000);
  });

  it("keyboard: the timeline pans and zooms, bars select, tree navigation still works", () => {
    const { container } = render(<TraceView events={hourIdle()} />);
    const timeline = screen.getByRole("group", { name: "Session timeline" });
    expect(timeline).toHaveAttribute("tabindex", "0");
    expect(timeline).toHaveAccessibleDescription(/plus and minus zoom/);
    fireEvent.keyDown(timeline, { key: "0" });
    expect(chart(container).dataset.zoomMode).toBe("fit");
    fireEvent.keyDown(timeline, { key: "+" });
    expect(chart(container).dataset.zoomMode).toBe("manual");
    const before = Number(chart(container).dataset.scrollLeft);
    fireEvent.keyDown(timeline, { key: "ArrowRight" });
    expect(Number(chart(container).dataset.scrollLeft)).toBeGreaterThan(before);
    fireEvent.keyDown(timeline, { key: "0" });
    expect(chart(container).dataset.scrollLeft).toBe("0");

    // Overview bars are buttons with accurate names; Enter/click selects.
    const bar = screen.getByRole("button", { name: "Select Turn 2" });
    bar.focus();
    fireEvent.click(bar);
    const row = within(tree()).getByRole("treeitem", { name: /Turn 2/ });
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    expect(within(tree()).getByRole("treeitem", { name: /Turn 2/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("toolbar", { name: "Overview zoom" })).toBeInTheDocument();
  });
});
