import type { Session } from "@open-managed-agents/domain/sessions";
import { describe, expect, it } from "vitest";
import {
  createSessionWakeups,
  type SessionWakeup,
  type SessionWakeupDelivery,
  type SessionWakeupDraft,
  type SessionWakeupEventSink,
  type SessionWakeupScheduler,
  type SessionWakeupSession,
  type SessionWakeupSessionSource,
} from "../src/index";

function session(status: Session["status"] = "idle"): Session {
  return {
    id: "session_01",
    agent: {
      id: "agent_01",
      description: null,
      mcpServers: [],
      model: { id: "claude-sonnet-4-6" },
      multiagent: null,
      name: "Agent",
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt: "2026-08-26T08:00:00.000Z",
    environmentId: "environment_01",
    metadata: {},
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status,
    title: null,
    updatedAt: "2026-08-26T08:00:00.000Z",
    usage: {},
    vaultIds: [],
  };
}

class FakeSessions implements SessionWakeupSessionSource {
  constructor(private current: Session | undefined = session()) {}

  set(next: Session | undefined): void {
    this.current = next;
  }

  async find(input: { workspaceId: string; sessionId: string }) {
    if (this.current === undefined || this.current.id !== input.sessionId) {
      return { type: "not_found" as const };
    }
    return { type: "found" as const, session: structuredClone(this.current) };
  }
}

class FakeScheduler implements SessionWakeupScheduler {
  readonly pending: SessionWakeup[] = [];

  async schedule(input: {
    wakeup: SessionWakeupDraft;
    maxPending: number;
  }) {
    if (this.pending.length >= input.maxPending) {
      return {
        type: "capacity_reached" as const,
        pending: this.pending.length,
      };
    }
    const wakeup = { ...structuredClone(input.wakeup), id: `wakeup_${this.pending.length + 1}` } as SessionWakeup;
    this.pending.push(wakeup);
    return { type: "scheduled" as const, wakeup: structuredClone(wakeup) };
  }

  async cancel(input: { workspaceId: string; sessionId: string; wakeupId: string }) {
    const index = this.pending.findIndex((wakeup) =>
      wakeup.workspaceId === input.workspaceId &&
      wakeup.sessionId === input.sessionId &&
      wakeup.id === input.wakeupId
    );
    if (index < 0) return { type: "not_found" as const };
    this.pending.splice(index, 1);
    return { type: "cancelled" as const };
  }

  async list(input: { workspaceId: string; sessionId: string }) {
    return this.pending
      .filter((wakeup) =>
        wakeup.workspaceId === input.workspaceId &&
        wakeup.sessionId === input.sessionId
      )
      .map((wakeup) => structuredClone(wakeup));
  }
}

class FakeEvents implements SessionWakeupEventSink {
  readonly scheduled: Array<{ session: SessionWakeupSession; wakeup: SessionWakeup }> = [];
  readonly fired: Array<{ session: SessionWakeupSession; wakeup: SessionWakeupDelivery; firedAt: string }> = [];

  async wakeupScheduled(input: { session: SessionWakeupSession; wakeup: SessionWakeup }): Promise<void> {
    this.scheduled.push(structuredClone(input));
  }

  async wakeupFired(input: {
    session: SessionWakeupSession;
    wakeup: SessionWakeupDelivery;
    firedAt: string;
  }): Promise<void> {
    this.fired.push(structuredClone(input));
  }
}

function fixture(status: Session["status"] = "idle") {
  const sessions = new FakeSessions(session(status));
  const scheduler = new FakeScheduler();
  const events = new FakeEvents();
  const wakeups = createSessionWakeups({
    sessions,
    scheduler,
    events,
    clock: { now: () => new Date("2026-08-26T09:00:00.000Z") },
    ids: { nextEventId: () => "event_schedule_01" },
  });
  return { events, scheduler, sessions, wakeups };
}

const scope = { workspaceId: "workspace_01", sessionId: "session_01" };

describe("Session wakeup application contract", () => {
  it("validates one timing selector without calling the scheduler", async () => {
    const { scheduler, wakeups } = fixture();

    await expect(wakeups.schedule({ ...scope, prompt: "later" })).resolves.toEqual({
      type: "invalid_input",
      path: "timing",
      message: "provide exactly one of delaySeconds, at, or cron",
    });
    await expect(wakeups.schedule({
      ...scope,
      prompt: "later",
      delaySeconds: 5,
      cron: "0 9 * * *",
    })).resolves.toMatchObject({ type: "invalid_input", path: "timing" });
    await expect(wakeups.schedule({ ...scope, prompt: "   ", delaySeconds: 5 }))
      .resolves.toMatchObject({ type: "invalid_input", path: "prompt" });

    expect(scheduler.pending).toHaveLength(0);
  });

  it("schedules camelCase one-shot input and emits a causal scheduled notice", async () => {
    const { events, wakeups } = fixture();

    const result = await wakeups.schedule({
      ...scope,
      prompt: "ping the user",
      delaySeconds: 5,
    });

    expect(result).toEqual({
      type: "scheduled",
      wakeup: {
        id: "wakeup_1",
        workspaceId: "workspace_01",
        sessionId: "session_01",
        prompt: "ping the user",
        kind: "one_shot",
        fireAt: "2026-08-26T09:00:05.000Z",
        scheduledAt: "2026-08-26T09:00:00.000Z",
        causalEventId: "event_schedule_01",
      },
    });
    expect(result.type).toBe("scheduled");
    if (result.type !== "scheduled") return;
    expect(events.scheduled).toEqual([{ session: session(), wakeup: result.wakeup }]);
  });

  it("returns explicit session and capacity outcomes", async () => {
    const terminated = fixture("terminated");
    await expect(terminated.wakeups.schedule({
      ...scope,
      prompt: "later",
      delaySeconds: 5,
    })).resolves.toEqual({ type: "terminated" });

    const missing = fixture();
    missing.sessions.set(undefined);
    await expect(missing.wakeups.schedule({
      ...scope,
      prompt: "later",
      delaySeconds: 5,
    })).resolves.toEqual({ type: "not_found" });

    const capped = fixture();
    for (let index = 0; index < 20; index += 1) {
      await capped.wakeups.schedule({
        ...scope,
        prompt: `slot ${index}`,
        at: `2026-08-27T${String(index).padStart(2, "0")}:00:00.000Z`,
      });
    }
    await expect(capped.wakeups.schedule({
      ...scope,
      prompt: "over cap",
      at: "2026-08-28T09:00:00.000Z",
    })).resolves.toEqual({ type: "capacity_reached", pending: 20, limit: 20 });
  });

  it("delivers a due wakeup once through the event sink and never resurrects a terminated session", async () => {
    const active = fixture();
    const scheduled = await active.wakeups.schedule({
      ...scope,
      prompt: "continue",
      cron: "0 9 * * *",
    });
    expect(scheduled.type).toBe("scheduled");
    if (scheduled.type !== "scheduled") return;

    await expect(active.wakeups.fire({ wakeup: scheduled.wakeup })).resolves.toEqual({
      type: "delivered",
    });
    expect(active.events.fired).toEqual([{
      session: session(),
      wakeup: scheduled.wakeup,
      firedAt: "2026-08-26T09:00:00.000Z",
    }]);

    active.sessions.set(session("terminated"));
    await expect(active.wakeups.fire({ wakeup: scheduled.wakeup })).resolves.toEqual({
      type: "terminated",
    });
    expect(active.events.fired).toHaveLength(1);
  });

  it("lists and cancels only within the full workspace/session scope", async () => {
    const { wakeups } = fixture();
    const scheduled = await wakeups.schedule({
      ...scope,
      prompt: "later",
      at: "2026-08-27T09:00:00.000Z",
    });
    expect(scheduled.type).toBe("scheduled");
    if (scheduled.type !== "scheduled") return;

    await expect(wakeups.list(scope)).resolves.toEqual({
      type: "listed",
      wakeups: [scheduled.wakeup],
    });
    await expect(wakeups.cancel({ ...scope, wakeupId: scheduled.wakeup.id }))
      .resolves.toEqual({ type: "cancelled" });
    await expect(wakeups.cancel({ ...scope, wakeupId: scheduled.wakeup.id }))
      .resolves.toEqual({ type: "not_found" });
  });
});
