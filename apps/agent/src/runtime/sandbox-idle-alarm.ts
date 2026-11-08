// The Session sandbox idle timer on a Durable Object (design §0.0 rule 11,
// §0.1 step 8): one cf_agents_schedules row for the SessionDO callback that
// calls idlePause(). The row survives eviction; cancel deletes it, so a fire
// always means the window ran out (session-sandbox-idle-pause.ts).

import type { SessionSandboxIdleTimer } from "@open-managed-agents/session-runtime";

export interface IdleAlarmSchedulerPort {
  schedule(delaySeconds: number, callback: string): Promise<unknown>;
  getSchedules(): Array<{ id: string; callback: string }>;
  cancelSchedule(id: string): Promise<boolean>;
}

export function createSandboxIdleAlarm(
  scheduler: IdleAlarmSchedulerPort,
  callback: string,
): Omit<SessionSandboxIdleTimer, "pauseMs"> {
  const cancel = async () => {
    for (const row of scheduler.getSchedules()) {
      if (row.callback === callback) await scheduler.cancelSchedule(row.id);
    }
  };
  return {
    async schedule(delayMs) {
      await cancel();
      await scheduler.schedule(Math.max(1, Math.ceil(delayMs / 1000)), callback);
    },
    cancel,
  };
}
