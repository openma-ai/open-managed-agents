import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Event } from "../../lib/events";
import { TimelineView } from "./TimelineView";
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
