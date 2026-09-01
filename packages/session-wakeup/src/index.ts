import type { SessionStatus } from "@open-managed-agents/domain/sessions";

export interface SessionWakeupScope {
  workspaceId: string;
  sessionId: string;
}

/** Complete Session projection required by the wakeup use cases. */
export interface SessionWakeupSession {
  id: string;
  status: SessionStatus;
}

interface SessionWakeupBase extends SessionWakeupScope {
  prompt: string;
  scheduledAt: string;
  causalEventId: string;
}

export type SessionWakeupDraft =
  | (SessionWakeupBase & {
      kind: "one_shot";
      fireAt: string;
      cron?: never;
    })
  | (SessionWakeupBase & {
      kind: "cron";
      cron: string;
      fireAt?: never;
    });

export type SessionWakeup = SessionWakeupDraft & { id: string };

/**
 * Alarm delivery needs causal data, not the backend's timing selector or ID.
 * This also keeps callbacks persisted by v0 readable during migration.
 */
export interface SessionWakeupDelivery extends SessionWakeupBase {
  id?: string;
  kind: "one_shot" | "cron";
}

export interface ScheduleSessionWakeup extends SessionWakeupScope {
  prompt: string;
  delaySeconds?: number;
  at?: string;
  cron?: string;
}

export interface CancelSessionWakeup extends SessionWakeupScope {
  wakeupId: string;
}

export interface FireSessionWakeup {
  wakeup: SessionWakeupDelivery;
}

export type ScheduleSessionWakeupResult =
  | { type: "scheduled"; wakeup: SessionWakeup }
  | { type: "not_found" }
  | { type: "terminated" }
  | { type: "invalid_input"; path: "timing" | "prompt" | "delaySeconds" | "at" | "cron"; message: string }
  | { type: "capacity_reached"; pending: number; limit: number };

export type CancelSessionWakeupResult =
  | { type: "cancelled" }
  | { type: "not_found" };

export type ListSessionWakeupsResult =
  | { type: "listed"; wakeups: SessionWakeup[] }
  | { type: "not_found" };

export type FireSessionWakeupResult =
  | { type: "delivered" }
  | { type: "not_found" }
  | { type: "terminated" };

type InvalidSessionWakeupInput = Extract<
  ScheduleSessionWakeupResult,
  { type: "invalid_input" }
>;

export interface SessionWakeupApplication {
  schedule(input: ScheduleSessionWakeup): Promise<ScheduleSessionWakeupResult>;
  cancel(input: CancelSessionWakeup): Promise<CancelSessionWakeupResult>;
  list(input: SessionWakeupScope): Promise<ListSessionWakeupsResult>;
  fire(input: FireSessionWakeup): Promise<FireSessionWakeupResult>;
}

export type FindSessionForWakeupResult =
  | { type: "found"; session: SessionWakeupSession }
  | { type: "not_found" };

export interface SessionWakeupSessionSource {
  find(input: SessionWakeupScope): Promise<FindSessionForWakeupResult>;
}

export interface ScheduleSessionWakeupOnPlatform {
  wakeup: SessionWakeupDraft;
  maxPending: number;
}

export type ScheduleSessionWakeupOnPlatformResult =
  | { type: "scheduled"; wakeup: SessionWakeup }
  | { type: "capacity_reached"; pending: number };

export interface SessionWakeupScheduler {
  schedule(
    input: ScheduleSessionWakeupOnPlatform,
  ): Promise<ScheduleSessionWakeupOnPlatformResult>;
  cancel(input: CancelSessionWakeup): Promise<CancelSessionWakeupResult>;
  list(input: SessionWakeupScope): Promise<SessionWakeup[]>;
}

export interface SessionWakeupEventSink {
  wakeupScheduled(input: {
    session: SessionWakeupSession;
    wakeup: SessionWakeup;
  }): Promise<void>;
  wakeupFired(input: {
    session: SessionWakeupSession;
    wakeup: SessionWakeupDelivery;
    firedAt: string;
  }): Promise<void>;
}

export interface SessionWakeupDependencies {
  sessions: SessionWakeupSessionSource;
  scheduler: SessionWakeupScheduler;
  events: SessionWakeupEventSink;
  clock: { now(): Date };
  ids: { nextEventId(): string };
  maxPending?: number;
}

function invalid(
  path: InvalidSessionWakeupInput["path"],
  message: string,
): InvalidSessionWakeupInput {
  return { type: "invalid_input", path, message };
}

function toDraft(
  input: ScheduleSessionWakeup,
  now: Date,
  causalEventId: string,
): SessionWakeupDraft | InvalidSessionWakeupInput {
  const timingCount = [input.delaySeconds, input.at, input.cron]
    .filter((value) => value !== undefined).length;
  if (timingCount !== 1) {
    return invalid(
      "timing",
      "provide exactly one of delaySeconds, at, or cron",
    );
  }
  if (input.prompt.trim().length === 0) {
    return invalid("prompt", "prompt is required");
  }

  const base: SessionWakeupBase = {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    prompt: input.prompt,
    scheduledAt: now.toISOString(),
    causalEventId,
  };
  if (input.delaySeconds !== undefined) {
    if (!Number.isFinite(input.delaySeconds) || input.delaySeconds < 0) {
      return invalid("delaySeconds", "delaySeconds must be a finite non-negative number");
    }
    return {
      ...base,
      kind: "one_shot",
      fireAt: new Date(now.getTime() + input.delaySeconds * 1_000).toISOString(),
    };
  }
  if (input.at !== undefined) {
    const fireAt = new Date(input.at);
    if (Number.isNaN(fireAt.getTime())) {
      return invalid("at", "at must be a valid timestamp");
    }
    return { ...base, kind: "one_shot", fireAt: fireAt.toISOString() };
  }
  const cron = input.cron?.trim() ?? "";
  if (cron.length === 0) return invalid("cron", "cron is required");
  return { ...base, kind: "cron", cron };
}

function isInvalid(
  value: SessionWakeupDraft | InvalidSessionWakeupInput,
): value is InvalidSessionWakeupInput {
  return "type" in value && value.type === "invalid_input";
}

export function createSessionWakeups(
  dependencies: SessionWakeupDependencies,
): SessionWakeupApplication {
  const maxPending = dependencies.maxPending ?? 20;
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new Error("maxPending must be a positive integer");
  }

  return {
    async schedule(input) {
      const draft = toDraft(
        input,
        dependencies.clock.now(),
        dependencies.ids.nextEventId(),
      );
      if (isInvalid(draft)) return draft;

      const located = await dependencies.sessions.find(input);
      if (located.type === "not_found") return located;
      if (located.session.status === "terminated") return { type: "terminated" };

      const scheduled = await dependencies.scheduler.schedule({
        wakeup: draft,
        maxPending,
      });
      if (scheduled.type === "capacity_reached") {
        return {
          type: "capacity_reached",
          pending: scheduled.pending,
          limit: maxPending,
        };
      }
      await dependencies.events.wakeupScheduled({
        session: located.session,
        wakeup: scheduled.wakeup,
      });
      return scheduled;
    },

    async cancel(input) {
      const located = await dependencies.sessions.find(input);
      if (located.type === "not_found") return located;
      return dependencies.scheduler.cancel(input);
    },

    async list(input) {
      const located = await dependencies.sessions.find(input);
      if (located.type === "not_found") return located;
      return {
        type: "listed",
        wakeups: await dependencies.scheduler.list(input),
      };
    },

    async fire(input) {
      const located = await dependencies.sessions.find(input.wakeup);
      if (located.type === "not_found") return located;
      if (located.session.status === "terminated") return { type: "terminated" };
      await dependencies.events.wakeupFired({
        session: located.session,
        wakeup: input.wakeup,
        firedAt: dependencies.clock.now().toISOString(),
      });
      return { type: "delivered" };
    },
  };
}
