/**
 * Session-create admission.
 *
 * Every path that persists a new Session (POST /v1/sessions, Deployment
 * launches) runs `SessionCreateAdmissionService.admit` BEFORE anything is
 * persisted or any runtime work is admitted. The policy (order of checks,
 * self-hosted/local skip, fail-open on meter errors, rejection shapes) lives
 * here so Cloudflare and Node share one semantics; hosts only provide the
 * storage/binding adapters below.
 */

/** Typed rejection mapped by the HTTP layer to 429 / 402. */
export type SessionCreateAdmissionRejection =
  | { type: "rate_limited"; message: string }
  | { type: "payment_required"; message: string; balanceCents: number };

export type SessionCreateAdmissionDecision =
  | { type: "admitted" }
  | SessionCreateAdmissionRejection;

export interface SessionCreateAdmissionInput {
  workspaceId: string;
  agentId: string;
  environmentId: string;
  /**
   * True when the Session runs on user-owned compute (self-hosted Environment,
   * local runtime, or an Agent bound to a local daemon). The usage meter is
   * skipped for these, matching the legacy `isLocalRuntime` behavior.
   */
  isLocalRuntime: boolean;
}

/** Inbound port consumed by the Sessions application service. */
export interface SessionCreateAdmissionPort {
  admit(input: SessionCreateAdmissionInput): Promise<SessionCreateAdmissionDecision>;
}

/** Short-window rate limiter adapter (e.g. CF Rate Limiting binding). */
export interface SessionCreateRateLimiterPort {
  /** Returns true when this create must be rejected. */
  exceeded(input: { workspaceId: string }): Promise<boolean>;
}

/** Daily create counter adapter (e.g. KV). */
export interface SessionCreateDailyCounterPort {
  /** Daily cap; `<= 0` disables the cap. */
  cap(): number;
  get(input: { workspaceId: string; day: string }): Promise<number>;
  increment(input: { workspaceId: string; day: string; next: number }): Promise<void>;
}

/** Usage/billing meter adapter (e.g. CF USAGE_METER service binding). */
export interface SessionUsageMeterPort {
  canStartSandbox(input: { workspaceId: string; agentId: string }): Promise<{
    ok: boolean;
    reason?: string;
    balanceCents?: number;
  }>;
}

export interface SessionCreateAdmissionLogger {
  warn(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

export interface SessionCreateAdmissionServiceDependencies {
  rateLimiter?: SessionCreateRateLimiterPort;
  dailyCounter?: SessionCreateDailyCounterPort;
  usageMeter?: SessionUsageMeterPort;
  clock: { now(): Date };
  logger?: SessionCreateAdmissionLogger;
}

export const SESSION_CREATE_RATE_LIMIT_MESSAGE =
  "Too many session creations — wait a minute";
export const SESSION_USAGE_REFUSED_MESSAGE =
  "Sandbox launch refused by usage meter";

const consoleLogger: SessionCreateAdmissionLogger = {
  warn: (message, fields) => console.warn(`[sessions] ${message}`, fields),
  error: (message, fields) => console.error(`[sessions] ${message}`, fields),
};

/**
 * Shared admission policy: rate limit → daily cap → usage gate.
 * The usage gate fails OPEN on meter exceptions (logged), matching the
 * legacy behavior.
 */
export class SessionCreateAdmissionService implements SessionCreateAdmissionPort {
  constructor(private readonly dependencies: SessionCreateAdmissionServiceDependencies) {}

  async admit(input: SessionCreateAdmissionInput): Promise<SessionCreateAdmissionDecision> {
    const { rateLimiter, dailyCounter, usageMeter, clock } = this.dependencies;
    const logger = this.dependencies.logger ?? consoleLogger;

    if (rateLimiter && (await rateLimiter.exceeded({ workspaceId: input.workspaceId }))) {
      return { type: "rate_limited", message: SESSION_CREATE_RATE_LIMIT_MESSAGE };
    }

    if (dailyCounter) {
      const cap = dailyCounter.cap();
      if (cap > 0) {
        const day = clock.now().toISOString().slice(0, 10);
        const current = await dailyCounter.get({ workspaceId: input.workspaceId, day });
        if (current >= cap) {
          logger.warn("tenant exceeded daily session creation cap", {
            op: "quota.daily_session_cap",
            workspace_id: input.workspaceId,
            current,
            cap,
          });
          return {
            type: "rate_limited",
            message: `Daily session creation limit reached (${cap}/day for this tenant). Resets at 00:00 UTC.`,
          };
        }
        await dailyCounter.increment({ workspaceId: input.workspaceId, day, next: current + 1 });
      }
    }

    if (usageMeter && !input.isLocalRuntime) {
      try {
        const gate = await usageMeter.canStartSandbox({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
        });
        if (!gate.ok) {
          return {
            type: "payment_required",
            message: gate.reason ?? SESSION_USAGE_REFUSED_MESSAGE,
            balanceCents: gate.balanceCents ?? 0,
          };
        }
      } catch (err) {
        logger.error("usage meter canStartSandbox failed; admitting (fail-open)", {
          op: "session.create.usage_gate_failed",
          workspace_id: input.workspaceId,
          agent_id: input.agentId,
          error_name: (err as Error)?.name ?? "unknown",
          error: (err as Error)?.message ?? String(err),
        });
      }
    }

    return { type: "admitted" };
  }
}

/** Admission with no adapters configured (self-hosted Node default). */
export const admitAllSessionCreates: SessionCreateAdmissionPort = {
  admit: async () => ({ type: "admitted" }),
};
