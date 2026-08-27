import { describe, expect, it } from "vitest";
import type { SessionWakeupDraft } from "../../session-wakeup/src/index";
import {
  CloudflareSessionWakeupScheduler,
  type CloudflareScheduleBackend,
  type CloudflareScheduleRecord,
} from "../src/index";

function draft(): SessionWakeupDraft {
  return {
    workspaceId: "workspace_01",
    sessionId: "session_01",
    prompt: "continue",
    kind: "one_shot",
    fireAt: "2026-08-27T09:00:00.000Z",
    scheduledAt: "2026-08-26T09:00:00.000Z",
    causalEventId: "event_schedule_01",
  };
}

class FakeBackend implements CloudflareScheduleBackend {
  readonly records: CloudflareScheduleRecord[] = [];
  private sequence = 0;

  async create(input: {
    when: Date | string;
    callback: string;
    payload: unknown;
  }): Promise<CloudflareScheduleRecord> {
    const record: CloudflareScheduleRecord = {
      id: `schedule_${++this.sequence}`,
      callback: input.callback,
      payload: structuredClone(input.payload),
      type: typeof input.when === "string" ? "cron" : "scheduled",
      time: typeof input.when === "string"
        ? 1_788_000_000
        : Math.floor(input.when.getTime() / 1_000),
      ...(typeof input.when === "string" && { cron: input.when }),
    };
    this.records.push(record);
    return structuredClone(record);
  }

  list(): CloudflareScheduleRecord[] {
    return this.records.map((record) => structuredClone(record));
  }

  async cancel(input: { id: string }): Promise<boolean> {
    const index = this.records.findIndex((record) => record.id === input.id);
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }
}

describe("CloudflareSessionWakeupScheduler", () => {
  it("atomically caps only wakeup callbacks and stores a native delivery payload", async () => {
    const backend = new FakeBackend();
    backend.records.push({
      id: "internal_recovery",
      callback: "recoverEventQueue",
      payload: {},
      type: "delayed",
      time: 1_788_000_000,
    });
    const scheduler = new CloudflareSessionWakeupScheduler({ backend });

    const scheduled = await scheduler.schedule({ wakeup: draft(), maxPending: 1 });
    expect(scheduled).toEqual({
      type: "scheduled",
      wakeup: { ...draft(), id: "schedule_1" },
    });
    expect(backend.records[1]).toMatchObject({
      callback: "onScheduledWakeup",
      payload: draft(),
    });
    await expect(scheduler.schedule({ wakeup: draft(), maxPending: 1 }))
      .resolves.toEqual({ type: "capacity_reached", pending: 1 });
  });

  it("reads legacy in-flight rows and refuses to cancel internal callbacks", async () => {
    const backend = new FakeBackend();
    backend.records.push(
      {
        id: "legacy_wakeup",
        callback: "onScheduledWakeup",
        payload: {
          prompt: "legacy",
          scheduled_at: "2026-08-26T08:00:00.000Z",
          kind: "cron",
          parent_event_id: "event_legacy",
        },
        type: "cron",
        time: 1_788_000_000,
        cron: "0 9 * * *",
      },
      {
        id: "internal_recovery",
        callback: "recoverEventQueue",
        payload: {},
        type: "delayed",
        time: 1_788_000_000,
      },
    );
    const scheduler = new CloudflareSessionWakeupScheduler({ backend });

    await expect(scheduler.list({
      workspaceId: "workspace_01",
      sessionId: "session_01",
    })).resolves.toEqual([{
      id: "legacy_wakeup",
      workspaceId: "workspace_01",
      sessionId: "session_01",
      prompt: "legacy",
      kind: "cron",
      cron: "0 9 * * *",
      scheduledAt: "2026-08-26T08:00:00.000Z",
      causalEventId: "event_legacy",
    }]);
    await expect(scheduler.cancel({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      wakeupId: "internal_recovery",
    })).resolves.toEqual({ type: "not_found" });
    await expect(scheduler.cancel({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      wakeupId: "legacy_wakeup",
    })).resolves.toEqual({ type: "cancelled" });
  });
});
