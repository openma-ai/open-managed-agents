import { describe, expect, it } from "vitest";
import { InMemoryEventLog } from "@open-managed-agents/event-log/memory";
import type { SessionEvent } from "@open-managed-agents/shared";

describe("worker user.tool_result queue input", () => {
  it("keeps the result queued until the normal event drain promotes it", () => {
    const log = new InMemoryEventLog(() => {});
    const event: SessionEvent = {
      id: "worker-result-event",
      type: "user.tool_result",
      tool_use_id: "toolu_worker",
      content: [{ type: "text", text: "completed" }],
    };

    expect(log.enqueueQueueInput(event, 1_800_000_000_000)).toBe(true);
    expect(log.peekQueueInput("sthr_primary")).toMatchObject({
      event_id: "worker-result-event",
      type: "user.tool_result",
    });
    expect(log.threadsWithQueueInputs()).toEqual(["sthr_primary"]);

    log.stampProcessed("worker-result-event", 1_800_000_000_100);
    expect(log.peekQueueInput("sthr_primary")).toBeNull();
    expect(log.getEvents()[0]).toMatchObject({
      id: "worker-result-event",
      type: "user.tool_result",
      processed_at: "2027-01-15T08:00:00.100Z",
    });
  });
});
