import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Event } from "../../lib/events";
// The original TimelineView is superseded by the unified TraceView; this
// file keeps the original Timeline behaviours under test against it.
import { TraceView as TimelineView } from "./TraceView";
import { eventTsMs, resolveTurnExpanded } from "./eventTime";

function turnEvents(turn: number, startIso: string): Event[] {
  const t0 = Date.parse(startIso);
  return [
    {
      type: "user.message",
      content: [{ type: "text", text: `msg-${turn}` }],
      delivery: "processed",
      ts: new Date(t0).toISOString(),
    },
    {
      type: "agent.message",
      content: [{ type: "text", text: `reply-${turn}` }],
      ts: new Date(t0 + 100).toISOString(),
    },
    {
      type: "session.status_idle",
      ts: new Date(t0 + 200).toISOString(),
    },
  ];
}

describe("eventTsMs", () => {
  it("parses ISO ts", () => {
    const ms = eventTsMs({
      type: "agent.message",
      ts: "2026-08-11T12:00:00.500Z",
    });
    expect(ms).toBe(Date.parse("2026-08-11T12:00:00.500Z"));
  });

  it("prefers occurred_at over ts", () => {
    const ms = eventTsMs({
      type: "agent.message",
      occurred_at: "2026-08-11T12:00:01.000Z",
      ts: "2026-08-11T12:00:00.000Z",
    } as Event);
    expect(ms).toBe(Date.parse("2026-08-11T12:00:01.000Z"));
  });

  it("ignores CMA processed_at", () => {
    const ms = eventTsMs({
      type: "agent.message",
      processed_at: "2026-08-11T12:00:01.000Z",
      ts: "2026-08-11T12:00:00.000Z",
    } as Event);
    expect(ms).toBe(Date.parse("2026-08-11T12:00:00.000Z"));
  });

  it("treats numeric ts as unix seconds", () => {
    expect(eventTsMs({ type: "x", ts: 1_700_000_000 })).toBe(1_700_000_000 * 1000);
  });
});

describe("resolveTurnExpanded", () => {
  it("auto-expands only the latest turn", () => {
    expect(resolveTurnExpanded("t1", "t3", {})).toBe(false);
    expect(resolveTurnExpanded("t3", "t3", {})).toBe(true);
  });

  it("honors explicit user overrides", () => {
    expect(resolveTurnExpanded("t1", "t3", { t1: true })).toBe(true);
    expect(resolveTurnExpanded("t3", "t3", { t3: false })).toBe(false);
  });
});

describe("TimelineView live append", () => {
  it("keeps only the latest turn auto-expanded as turns append", async () => {
    const user = userEvent.setup();
    const first = turnEvents(1, "2026-08-11T10:00:00.000Z");
    const { rerender } = render(<TimelineView events={first} />);

    // One expand control; latest is open (▾).
    expect(screen.getAllByTitle("Collapse")).toHaveLength(1);
    expect(screen.queryByTitle("Expand")).toBeNull();

    const two = [...first, ...turnEvents(2, "2026-08-11T10:01:00.000Z")];
    rerender(<TimelineView events={two} />);

    // Previous latest collapsed; new latest expanded.
    expect(screen.getAllByTitle("Expand")).toHaveLength(1);
    expect(screen.getAllByTitle("Collapse")).toHaveLength(1);

    const three = [...two, ...turnEvents(3, "2026-08-11T10:02:00.000Z")];
    rerender(<TimelineView events={three} />);

    expect(screen.getAllByTitle("Expand")).toHaveLength(2);
    expect(screen.getAllByTitle("Collapse")).toHaveLength(1);

    // Explicit override: keep an older turn open while latest stays open.
    await user.click(screen.getAllByTitle("Expand")[0]);
    expect(screen.getAllByTitle("Collapse")).toHaveLength(2);
    expect(screen.getAllByTitle("Expand")).toHaveLength(1);
  });
});

describe("TimelineView queued turns", () => {
  it("marks a queued turn.queued and clears the badge when delivery processed arrives", () => {
    const t0 = Date.parse("2026-08-11T11:00:00.000Z");
    const queued: Event = {
      type: "turn.queued",
      id: "sevt_queued",
      content: [{ type: "text", text: "waiting" }],
      delivery: "queued",
      ts: new Date(t0).toISOString(),
    };
    const { container, rerender } = render(<TimelineView events={[queued]} />);

    expect(container.querySelector("[data-timeline-turn-queued]")).toBeInTheDocument();

    const processed: Event = {
      type: "user.message",
      id: "sevt_queued",
      content: [{ type: "text", text: "waiting" }],
      delivery: "processed",
      ts: new Date(t0).toISOString(),
    };
    rerender(<TimelineView events={[processed]} />);

    expect(container.querySelector("[data-timeline-turn-queued]")).toBeNull();
  });
});

function at(iso: string, ms: number) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

const T = "2026-08-11T10:00:00.000Z";

/** Turn 1 (closed at +1s) → 1h idle → turn 2 (closed). */
function hourGap(nextExtra: Record<string, unknown> = {}): Event[] {
  return [
    { type: "user.message", content: [{ type: "text", text: "a" }], ts: at(T, 0) },
    { type: "agent.tool_use", id: "t1", name: "read", input: { file_path: "/x" }, ts: at(T, 100) },
    { type: "agent.tool_result", tool_use_id: "t1", content: "x", ts: at(T, 900) },
    { type: "session.status_idle", ts: at(T, 1000) },
    { type: "user.message", content: [{ type: "text", text: "b" }], ts: at(T, 3_601_000), ...nextExtra },
    { type: "session.status_idle", ts: at(T, 3_602_000) },
  ];
}

function gapRows(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-gap-kind]")];
}

describe("TimelineView idle dividers (original IdleDivider rule)", () => {
  it("shows '↓ {duration} idle' when the previous turn closed and the next trigger is later", () => {
    const { container } = render(<TimelineView events={hourGap()} />);
    const rows = gapRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-gap-kind", "idle");
    expect(rows[0]).toHaveTextContent("↓ 60m0s idle");
    expect(rows[0]).not.toHaveTextContent("scheduled wakeup");
  });

  it("appends 'scheduled wakeup' when the next turn is a wakeup", () => {
    const { container } = render(<TimelineView events={hourGap({ metadata: { harness: "schedule", kind: "wakeup" } })} />);
    expect(gapRows(container)[0]).toHaveTextContent("↓ 60m0s idle · scheduled wakeup");
  });

  it("does not invent idle when the previous turn has no close event", () => {
    const events: Event[] = [
      { type: "user.message", content: [{ type: "text", text: "a" }], ts: at(T, 0) },
      { type: "agent.message", content: [{ type: "text", text: "…" }], ts: at(T, 500) },
      { type: "user.message", content: [{ type: "text", text: "b" }], ts: at(T, 5000) },
    ];
    const { container } = render(<TimelineView events={events} />);
    const rows = gapRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-gap-kind", "unknown");
    expect(rows[0]).toHaveTextContent("? 4.50s unknown · not classified as idle");
    expect(rows[0]).not.toHaveTextContent("↓");
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
  });

  it("does not invent idle when the next trigger has no timestamp", () => {
    const events = hourGap();
    delete events[4]!.ts;
    const { container } = render(<TimelineView events={events} />);
    expect(gapRows(container)[0]).toHaveAttribute("data-gap-kind", "unknown");
    expect(gapRows(container)[0]).toHaveTextContent("gap unknown");
  });

  it("session.thread_idle is a thread marker row, not an idle divider", () => {
    const events: Event[] = [
      { type: "user.message", content: [{ type: "text", text: "a" }], ts: at(T, 0) },
      { type: "session.thread_idle", session_thread_id: "sthr_primary", ts: at(T, 100) },
      { type: "agent.message", content: [{ type: "text", text: "b" }], ts: at(T, 60_000) },
    ];
    const { container } = render(<TimelineView events={events} />);
    expect(gapRows(container)).toHaveLength(0);
    expect(screen.getByRole("treeitem", { name: /thread_idle/ })).toBeInTheDocument();
  });

  it("span.wakeup_scheduled is an in-turn schedule wait row with its real duration", () => {
    const events: Event[] = [
      { type: "user.message", content: [{ type: "text", text: "later" }], ts: at(T, 0) },
      { type: "span.wakeup_scheduled", id: "w1", ts: at(T, 10) },
      { type: "session.status_idle", ts: at(T, 20) },
      { type: "user.message", parent_event_id: "w1", metadata: { harness: "schedule", kind: "wakeup" }, content: [{ type: "text", text: "wake" }], ts: at(T, 30_010) },
    ];
    render(<TimelineView events={events} />);
    // Turn 1 is collapsed (not latest): expand it.
    fireEvent.click(screen.getAllByTitle("Expand")[0]!);
    const row = screen.getByRole("treeitem", { name: /schedule waiting/ });
    expect(row).toHaveTextContent("30.00s");
  });
});

describe("TimelineView collapsible idle gaps", () => {
  const gapBarWidth = (container: HTMLElement) =>
    parseFloat(container.querySelector<HTMLElement>("[data-gap-bar]")!.style.width);

  it("collapses a gap on the overview, keeps its true duration, and restores the full wall-clock gap", () => {
    const { container } = render(<TimelineView events={hourGap()} />);
    // Wall clock is the default: nothing collapsed.
    fireEvent.click(screen.getByRole("button", { name: "Fit session to viewport" }));
    const full = gapBarWidth(container);
    expect(full).toBeGreaterThan(700);
    expect(container.querySelector("[data-gap-bar]")).not.toHaveAttribute("data-collapsed");

    fireEvent.click(screen.getByRole("button", { name: "Collapse 60m0s idle gap" }));
    const collapsedRow = gapRows(container)[0]!;
    expect(collapsedRow).toHaveTextContent("↓ 60m0s idle · collapsed");
    expect(container.querySelector("[data-gap-bar]")).toHaveAttribute("data-collapsed", "true");
    expect(gapBarWidth(container)).toBeLessThan(40);
    expect(screen.getByRole("button", { name: "Select 60m0s idle (collapsed)" })).toBeInTheDocument();

    // Inspector still reports the true duration.
    fireEvent.click(collapsedRow);
    const details = screen.getByRole("complementary", { name: "Event details" });
    expect(within(details).getByText("Known idle (between turns)")).toBeInTheDocument();
    expect(within(details).getByText("60m0s")).toBeInTheDocument();

    fireEvent.click(within(details).getByRole("button", { name: "Restore full wall-clock gap" }));
    expect(gapRows(container)[0]).not.toHaveTextContent("collapsed");
    expect(gapBarWidth(container)).toBeCloseTo(full);
  });

  it("collapse-all toggles every idle gap and back", () => {
    const { container } = render(<TimelineView events={hourGap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse idle gaps" }));
    expect(gapRows(container)[0]).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Restore idle gaps" }));
    expect(gapRows(container)[0]).not.toHaveAttribute("data-collapsed");
  });
});

describe("TimelineView turn collapse and zoom (original behaviour)", () => {
  it("collapsed turns render no step rows; expanding shows them", () => {
    render(<TimelineView events={hourGap()} />);
    // Latest turn expanded, first collapsed: its read step isn't rendered.
    expect(screen.queryByRole("treeitem", { name: /^read/ })).toBeNull();
    fireEvent.click(screen.getAllByTitle("Expand")[0]!);
    expect(screen.getByRole("treeitem", { name: /^read/ })).toHaveTextContent("800ms");
    fireEvent.click(screen.getAllByTitle("Collapse")[0]!);
    expect(screen.queryByRole("treeitem", { name: /^read/ })).toBeNull();
  });

  it("defaults to auto density and supports fit, zoom in/out", () => {
    render(<TimelineView events={hourGap()} />);
    const auto = screen.getByRole("button", { name: "Auto-pick scale by event density" });
    expect(auto).toHaveAttribute("aria-pressed", "true");
    const rate = () => screen.getByTestId("overview-rate").textContent;
    fireEvent.click(screen.getByRole("button", { name: "Fit session to viewport" }));
    const fitRate = rate();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(rate()).not.toBe(fitRate);
    expect(auto).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(rate()).toBe(fitRate);
    fireEvent.click(auto);
    expect(auto).toHaveAttribute("aria-pressed", "true");
  });
});

describe("TraceView responsive layout", () => {
  it("stacks tree and inspector on narrow viewports and never uses fixed panel widths", () => {
    const { container } = render(<TimelineView events={hourGap()} />);
    const root = container.querySelector<HTMLElement>("[data-trace-root]")!;
    expect(root.className).toMatch(/\bmin-w-0\b/);
    expect(root.className).toMatch(/\boverflow-x-hidden\b/);
    const grid = screen.getByRole("navigation", { name: "Trace tree" }).parentElement!;
    expect(grid.className).toMatch(/\bgrid-cols-1\b/);
    expect(grid.className).toMatch(/md:grid-cols-/);
    for (const el of [screen.getByRole("navigation", { name: "Trace tree" }), screen.getByRole("complementary", { name: "Event details" })]) {
      expect(el.getAttribute("style")).toBeNull();
      expect(el.className).toMatch(/\bmin-w-0\b/);
    }
    // The wide chart scrolls inside its own container instead of the page.
    const chart = container.querySelector<HTMLElement>("[data-overview-chart]")!;
    expect(chart.parentElement!.className).toMatch(/overflow-x-auto/);
    expect(chart.parentElement!.className).toMatch(/max-w-full/);
  });
});
