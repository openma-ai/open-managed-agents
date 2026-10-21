/**
 * Scheduled Loops. OpenMatter leaves timers to the host (docs/LOOPS.md,
 * "Proactive Loops"): a tick is one more Event source. Here a Loop template
 * that subscribes to `schedule.tick` gets two host fields, `schedule` (a cron
 * expression) and `timezone`. Each connection that runs such a Loop also runs
 * a timer source: at each time the cron names it delivers an envelope to the
 * connection's inbox, keyed by the Loop and the scheduled time, so replicas
 * that all fire it put it in the shared inbox once. The `schedule`
 * integration turns it into a `schedule.<loopId>.tick` WorkEvent, and the
 * Loop is installed with `schedule.tick` renamed to that type, so two
 * scheduled Loops on one Bond each see only their own ticks.
 *
 * A tick missed while no replica ran is not made up.
 */

import type { LoopIssue } from "./issues.js";
import type { LongConnectionSource, ReceivedEnvelope } from "@openma/matter-host-local/runtime";
import type { WorkIntegration } from "@openma/matter/integration";
import { IntegrationError } from "@openma/matter/integration";
import { defineLoop, type Loop, type LoopApp } from "@openma/matter-loop";
import { CronExpressionParser } from "cron-parser";
import { Effect } from "effect";

/** The Event type a template subscribes to for its schedule. */
export const SCHEDULE_TICK = "schedule.tick";

export const SCHEDULE_INTEGRATION_ID = "schedule";

/** The host fields of a scheduled template, after its own. */
export const SCHEDULE_FIELDS = {
  schedule: {
    type: "string",
    minLength: 1,
    title: "Schedule",
    description: "When the Loop runs, as a cron expression: minute hour day-of-month month day-of-week.",
    "x-oma-widget": "cron",
    "x-oma-section": "trigger",
  },
  timezone: {
    type: "string",
    minLength: 1,
    default: "UTC",
    title: "Time zone",
    description: "The IANA time zone the schedule is read in, such as Asia/Shanghai.",
    "x-oma-widget": "timezone",
    "x-oma-section": "trigger",
  },
} as const;

/** Whether a template runs on a schedule. */
export const isScheduled = (loop: Loop): boolean => {
  const spec = loop.definition.spec as { sources?: unknown } | undefined;
  return Array.isArray(spec?.sources) && spec.sources.includes(SCHEDULE_TICK);
};

/**
 * What is wrong with a schedule, or undefined when it is valid. The code and
 * params let a console say it in the user's language; message is English.
 */
export const scheduleIssue = (schedule: unknown, timezone: unknown): LoopIssue | undefined => {
  if (typeof schedule !== "string" || schedule.trim() === "") {
    return { field: "schedule", code: "required", message: "Schedule is required" };
  }
  if (schedule.trim().split(/\s+/).length !== 5) {
    return {
      field: "schedule",
      code: "schedule_fields",
      message: "Schedule must have five fields: minute hour day-of-month month day-of-week",
    };
  }
  const tz = typeof timezone === "string" && timezone !== "" ? timezone : "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    return { field: "timezone", code: "timezone_unknown", params: { timezone: tz }, message: `Unknown time zone ${tz}` };
  }
  try {
    CronExpressionParser.parse(schedule, { tz });
  } catch (error) {
    return {
      field: "schedule",
      code: "schedule_invalid",
      message: `Invalid schedule: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return undefined;
};

/** The problem with a schedule in English, or undefined when it is valid. */
export const scheduleProblem = (schedule: unknown, timezone: unknown): string | undefined =>
  scheduleIssue(schedule, timezone)?.message;

/** The first time after `after` that the schedule names. */
export const nextFire = (schedule: string, timezone: string, after: Date): Date =>
  CronExpressionParser.parse(schedule, { tz: timezone, currentDate: after }).next().toDate();

/** One scheduled Loop of a connection. */
export interface LoopSchedule {
  readonly loopId: string;
  readonly schedule: string;
  readonly timezone: string;
}

/** What a tick carries; also the envelope body. */
interface TickBody {
  readonly loopId: string;
  readonly scheduledAt: string;
  readonly authority: string;
}

const tickType = (loopId: string) => `schedule.${loopId}.tick`;

export interface ScheduleTimers {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const realTimers: ScheduleTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** setTimeout caps its delay at 2^31-1 ms; longer waits are chained. */
const MAX_DELAY = 2_147_483_647;

/**
 * Fires each Loop's ticks. `authority` names the Bond, as the provider's own
 * events do. A failed delivery is reported and the next tick still fires.
 */
export const makeScheduleSource = (options: {
  readonly schedules: readonly LoopSchedule[];
  readonly authority: string;
  readonly timers?: ScheduleTimers;
  readonly onError?: (error: unknown) => void;
}): LongConnectionSource => {
  const timers = options.timers ?? realTimers;
  const handles = new Map<string, unknown>();
  let deliver: ((envelope: ReceivedEnvelope) => Promise<void>) | undefined;

  const arm = (entry: LoopSchedule, after: number) => {
    const at = nextFire(entry.schedule, entry.timezone, new Date(after)).getTime();
    const wait = (until: number) => {
      const delay = Math.max(0, until - timers.now());
      handles.set(
        entry.loopId,
        timers.setTimeout(
          () => {
            if (deliver === undefined) return;
            if (timers.now() < until) return wait(until);
            const scheduledAt = new Date(until).toISOString();
            const body: TickBody = { loopId: entry.loopId, scheduledAt, authority: options.authority };
            void deliver({
              integrationId: SCHEDULE_INTEGRATION_ID,
              idempotencyKey: `schedule:${entry.loopId}:${scheduledAt}`,
              eventType: tickType(entry.loopId),
              body,
            }).catch((error) => options.onError?.(error));
            arm(entry, until);
          },
          Math.min(delay, MAX_DELAY),
        ),
      );
    };
    wait(at);
  };

  return {
    start: async (onEnvelope) => {
      if (deliver !== undefined) return;
      deliver = onEnvelope;
      for (const entry of options.schedules) arm(entry, timers.now());
    },
    stop: async () => {
      deliver = undefined;
      for (const handle of handles.values()) timers.clearTimeout(handle);
      handles.clear();
    },
  };
};

/** Runs two sources as one; each envelope keeps its own integration. */
export const combineSources = (a: LongConnectionSource, b: LongConnectionSource): LongConnectionSource => ({
  start: async (onEnvelope) => {
    await a.start(onEnvelope);
    try {
      await b.start(onEnvelope);
    } catch (error) {
      await a.stop().catch(() => undefined);
      throw error;
    }
  },
  stop: async () => {
    const results = await Promise.allSettled([a.stop(), b.stop()]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  },
});

const isTick = (value: unknown): value is TickBody => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.loopId === "string" && typeof v.scheduledAt === "string" && typeof v.authority === "string";
};

/** Turns a tick envelope into its WorkEvent. It delivers nothing. */
export const makeScheduleIntegration = (): WorkIntegration => ({
  manifest: {
    id: SCHEDULE_INTEGRATION_ID,
    displayName: "Schedule",
    events: ["*"],
    operations: [],
  },
  ingest: (input) =>
    isTick(input)
      ? Effect.succeed([
          {
            schemaVersion: "0.1",
            id: `schedule:${input.loopId}:${input.scheduledAt}`,
            type: tickType(input.loopId),
            occurredAt: input.scheduledAt,
            receivedAt: new Date().toISOString(),
            idempotencyKey: `schedule:${input.loopId}:${input.scheduledAt}`,
            source: { provider: SCHEDULE_INTEGRATION_ID, authority: input.authority },
            payload: { scheduledAt: input.scheduledAt },
          },
        ])
      : Effect.fail(new IntegrationError({ message: "Invalid schedule tick", retryable: false })),
  deliver: () =>
    Effect.fail(new IntegrationError({ message: "The schedule integration delivers nothing", retryable: false })),
});

/**
 * The template with `schedule.tick` renamed to this Loop's own tick type, in
 * its sources and in the handlers it registers.
 */
export const scheduledLoop = (loop: Loop, loopId: string): Loop => {
  const rename = (type: string) => (type === SCHEDULE_TICK ? tickType(loopId) : type);
  const spec = (loop.definition.spec ?? {}) as Record<string, unknown>;
  const sources = Array.isArray(spec.sources) ? spec.sources.map((s) => (typeof s === "string" ? rename(s) : s)) : [];
  return defineLoop(
    { ...loop.definition, spec: { ...spec, sources } } as Loop["definition"],
    (app, context) => {
      const renamed: LoopApp = {
        on: (types, handler) => {
          app.on(typeof types === "string" ? rename(types) : types.map(rename), handler);
          return renamed;
        },
      };
      loop.install(renamed, context);
    },
  );
};
