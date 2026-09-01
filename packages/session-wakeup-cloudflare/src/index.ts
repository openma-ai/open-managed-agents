import type {
  CancelSessionWakeup,
  CancelSessionWakeupResult,
  ScheduleSessionWakeupOnPlatform,
  ScheduleSessionWakeupOnPlatformResult,
  SessionWakeup,
  SessionWakeupDraft,
  SessionWakeupScheduler,
  SessionWakeupScope,
} from "@open-managed-agents/session-wakeup";

export const CLOUDFLARE_WAKEUP_CALLBACK = "onScheduledWakeup";

export interface CloudflareScheduleRecord {
  id: string;
  callback: string;
  payload: unknown;
  type: string;
  time: number;
  cron?: string;
}

export interface CloudflareScheduleBackend {
  create(input: {
    when: Date | string;
    callback: string;
    payload: unknown;
  }): Promise<CloudflareScheduleRecord>;
  list(): CloudflareScheduleRecord[];
  cancel(input: { id: string }): Promise<boolean>;
}

export interface CloudflareSessionWakeupSchedulerOptions {
  backend: CloudflareScheduleBackend;
}

export class CloudflareSessionWakeupScheduler
  implements SessionWakeupScheduler
{
  constructor(
    private readonly options: CloudflareSessionWakeupSchedulerOptions,
  ) {}

  async schedule(
    input: ScheduleSessionWakeupOnPlatform,
  ): Promise<ScheduleSessionWakeupOnPlatformResult> {
    const pending = this.options.backend.list()
      .filter((record) => record.callback === CLOUDFLARE_WAKEUP_CALLBACK)
      .length;
    if (pending >= input.maxPending) {
      return { type: "capacity_reached", pending };
    }
    const record = await this.options.backend.create({
      when: input.wakeup.kind === "cron"
        ? input.wakeup.cron
        : new Date(input.wakeup.fireAt),
      callback: CLOUDFLARE_WAKEUP_CALLBACK,
      payload: structuredClone(input.wakeup),
    });
    const wakeup = decodeWakeup(record, input.wakeup);
    if (wakeup === null) {
      throw new Error(`Cloudflare scheduler returned an invalid wakeup ${record.id}`);
    }
    return { type: "scheduled", wakeup };
  }

  async cancel(
    input: CancelSessionWakeup,
  ): Promise<CancelSessionWakeupResult> {
    const record = this.options.backend.list().find(
      (candidate) => candidate.id === input.wakeupId,
    );
    if (
      record === undefined ||
      record.callback !== CLOUDFLARE_WAKEUP_CALLBACK ||
      decodeWakeup(record, input) === null
    ) return { type: "not_found" };
    return await this.options.backend.cancel({ id: input.wakeupId })
      ? { type: "cancelled" }
      : { type: "not_found" };
  }

  async list(input: SessionWakeupScope): Promise<SessionWakeup[]> {
    return this.listNow(input);
  }

  /** Synchronous compatibility view for the existing schedule tool surface. */
  listNow(input: SessionWakeupScope): SessionWakeup[] {
    return this.options.backend.list()
      .filter((record) => record.callback === CLOUDFLARE_WAKEUP_CALLBACK)
      .map((record) => decodeWakeup(record, input))
      .filter((wakeup): wakeup is SessionWakeup => wakeup !== null);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function decodeWakeup(
  record: CloudflareScheduleRecord,
  scope: SessionWakeupScope,
): SessionWakeup | null {
  if (!isObject(record.payload)) return null;
  const payload = record.payload;
  const workspaceId = typeof payload.workspaceId === "string"
    ? payload.workspaceId
    : scope.workspaceId;
  const sessionId = typeof payload.sessionId === "string"
    ? payload.sessionId
    : scope.sessionId;
  if (workspaceId !== scope.workspaceId || sessionId !== scope.sessionId) {
    return null;
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt : null;
  const scheduledAt = typeof payload.scheduledAt === "string"
    ? payload.scheduledAt
    : typeof payload.scheduled_at === "string"
      ? payload.scheduled_at
      : null;
  const causalEventId = typeof payload.causalEventId === "string"
    ? payload.causalEventId
    : typeof payload.parent_event_id === "string"
      ? payload.parent_event_id
      : null;
  const kind = payload.kind;
  if (
    prompt === null ||
    scheduledAt === null ||
    causalEventId === null ||
    (kind !== "one_shot" && kind !== "cron")
  ) return null;

  const base = {
    id: record.id,
    workspaceId,
    sessionId,
    prompt,
    scheduledAt,
    causalEventId,
  };
  if (kind === "cron") {
    const cron = record.cron ??
      (typeof payload.cron === "string" ? payload.cron : undefined);
    return cron === undefined ? null : { ...base, kind, cron };
  }
  return {
    ...base,
    kind,
    fireAt: new Date(record.time * 1_000).toISOString(),
  };
}

export type { SessionWakeupDraft };
