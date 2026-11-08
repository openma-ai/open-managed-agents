import { describe, it, expect } from "vitest";
import { createMonotonicClock } from "@open-managed-agents/shared";
import { InMemoryHistory } from "../../src/history/in-memory-history";

describe("history stamp via monotonic clock", () => {
  it("consecutive agent appends get strictly increasing processed_at", () => {
    let t = 1_000;
    const clock = createMonotonicClock(() => t); // same wall ms unless bumped by clock
    const h = new InMemoryHistory(clock);
    h.append({ type: "agent.tool_result", tool_use_id: "a", content: "x" } as never);
    h.append({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["b"] },
    } as never);
    const ev = h.getEvents();
    expect(ev).toHaveLength(2);
    expect(ev[0]!.processed_at! < ev[1]!.processed_at!).toBe(true);
    // Same wall reading would collide without the clock bump:
    expect(ev[0]!.processed_at).toBe(new Date(1000).toISOString());
    expect(ev[1]!.processed_at).toBe(new Date(1001).toISOString());
  });
});
