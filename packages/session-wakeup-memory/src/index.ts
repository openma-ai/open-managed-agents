import type {
  CancelSessionWakeup,
  CancelSessionWakeupResult,
  ScheduleSessionWakeupOnPlatform,
  ScheduleSessionWakeupOnPlatformResult,
  SessionWakeup,
  SessionWakeupScheduler,
  SessionWakeupScope,
} from "@open-managed-agents/session-wakeup";

export interface MemorySessionWakeupSchedulerOptions {
  ids: { nextWakeupId(): string };
}

/**
 * Deterministic in-memory registration adapter. A platform timer or test
 * driver remains responsible for invoking SessionWakeupApplication.fire.
 */
export class MemorySessionWakeupScheduler implements SessionWakeupScheduler {
  private readonly workspaces = new Map<
    string,
    Map<string, Map<string, SessionWakeup>>
  >();

  constructor(private readonly options: MemorySessionWakeupSchedulerOptions) {}

  async schedule(
    input: ScheduleSessionWakeupOnPlatform,
  ): Promise<ScheduleSessionWakeupOnPlatformResult> {
    const wakeups = this.wakeups(input.wakeup, true);
    if (wakeups.size >= input.maxPending) {
      return { type: "capacity_reached", pending: wakeups.size };
    }
    const wakeup: SessionWakeup = {
      ...structuredClone(input.wakeup),
      id: this.options.ids.nextWakeupId(),
    };
    wakeups.set(wakeup.id, wakeup);
    return { type: "scheduled", wakeup: structuredClone(wakeup) };
  }

  async cancel(
    input: CancelSessionWakeup,
  ): Promise<CancelSessionWakeupResult> {
    const wakeups = this.wakeups(input);
    if (wakeups?.has(input.wakeupId) !== true) return { type: "not_found" };
    wakeups.delete(input.wakeupId);
    this.compact(input);
    return { type: "cancelled" };
  }

  async list(input: SessionWakeupScope): Promise<SessionWakeup[]> {
    return [...(this.wakeups(input)?.values() ?? [])]
      .map((wakeup) => structuredClone(wakeup));
  }

  private wakeups(
    input: SessionWakeupScope,
    create: true,
  ): Map<string, SessionWakeup>;
  private wakeups(
    input: SessionWakeupScope,
    create?: false,
  ): Map<string, SessionWakeup> | undefined;
  private wakeups(
    input: SessionWakeupScope,
    create = false,
  ): Map<string, SessionWakeup> | undefined {
    let sessions = this.workspaces.get(input.workspaceId);
    if (sessions === undefined) {
      if (!create) return undefined;
      sessions = new Map();
      this.workspaces.set(input.workspaceId, sessions);
    }
    let wakeups = sessions.get(input.sessionId);
    if (wakeups === undefined && create) {
      wakeups = new Map();
      sessions.set(input.sessionId, wakeups);
    }
    return wakeups;
  }

  private compact(input: SessionWakeupScope): void {
    const sessions = this.workspaces.get(input.workspaceId);
    const wakeups = sessions?.get(input.sessionId);
    if (wakeups !== undefined && wakeups.size === 0) {
      sessions?.delete(input.sessionId);
    }
    if (sessions !== undefined && sessions.size === 0) {
      this.workspaces.delete(input.workspaceId);
    }
  }
}
