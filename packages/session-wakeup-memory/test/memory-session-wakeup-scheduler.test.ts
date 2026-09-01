import { describe, expect, it } from "vitest";
import type { SessionWakeupDraft } from "../../session-wakeup/src/index";
import { MemorySessionWakeupScheduler } from "../src/index";

function draft(
  workspaceId = "workspace_01",
  sessionId = "session_same",
): SessionWakeupDraft {
  return {
    workspaceId,
    sessionId,
    prompt: "continue",
    kind: "one_shot",
    fireAt: "2026-08-27T09:00:00.000Z",
    scheduledAt: "2026-08-26T09:00:00.000Z",
    causalEventId: "event_schedule_01",
  };
}

describe("MemorySessionWakeupScheduler", () => {
  it("enforces capacity atomically per workspace/session scope", async () => {
    let sequence = 0;
    const scheduler = new MemorySessionWakeupScheduler({
      ids: { nextWakeupId: () => `wakeup_${++sequence}` },
    });

    await expect(scheduler.schedule({ wakeup: draft(), maxPending: 1 }))
      .resolves.toMatchObject({ type: "scheduled" });
    await expect(scheduler.schedule({ wakeup: draft(), maxPending: 1 }))
      .resolves.toEqual({ type: "capacity_reached", pending: 1 });

    await expect(scheduler.schedule({
      wakeup: draft("workspace_02"),
      maxPending: 1,
    })).resolves.toMatchObject({ type: "scheduled" });
  });

  it("lists immutable copies and cancels only in the complete tenant scope", async () => {
    const scheduler = new MemorySessionWakeupScheduler({
      ids: { nextWakeupId: () => "wakeup_01" },
    });
    const scheduled = await scheduler.schedule({
      wakeup: draft(),
      maxPending: 20,
    });
    expect(scheduled.type).toBe("scheduled");
    if (scheduled.type !== "scheduled") return;

    const firstList = await scheduler.list({
      workspaceId: "workspace_01",
      sessionId: "session_same",
    });
    firstList[0]!.prompt = "mutated outside";
    await expect(scheduler.list({
      workspaceId: "workspace_01",
      sessionId: "session_same",
    })).resolves.toEqual([scheduled.wakeup]);

    await expect(scheduler.cancel({
      workspaceId: "workspace_02",
      sessionId: "session_same",
      wakeupId: "wakeup_01",
    })).resolves.toEqual({ type: "not_found" });
    await expect(scheduler.cancel({
      workspaceId: "workspace_01",
      sessionId: "session_same",
      wakeupId: "wakeup_01",
    })).resolves.toEqual({ type: "cancelled" });
    await expect(scheduler.list({
      workspaceId: "workspace_01",
      sessionId: "session_same",
    })).resolves.toEqual([]);
  });
});
