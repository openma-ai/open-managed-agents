/**
 * Session-create admission.
 *
 * Every path that persists a new Session (POST /v1/sessions, Deployment
 * launches) runs `SessionCreateAdmissionService.admit` BEFORE anything is
 * persisted or any runtime work is admitted. The policy (order of checks,
 * fail-open on hook errors, rejection shapes) lives here so Cloudflare and
 * Node share one semantics; hosts only provide the storage/binding adapters
 * and an optional, policy-free admission hook below.
 */

/**
 * Typed rejection. `rate_limited` maps to 429; a host hook denial carries its
 * own HTTP status and body, which the HTTP layer returns verbatim.
 */
export type SessionCreateAdmissionRejection =
  | { type: "rate_limited"; message: string }
  | { type: "denied"; status: number; body: unknown };

export type SessionCreateAdmissionDecision =
  | { type: "admitted" }
  | SessionCreateAdmissionRejection;

export interface SessionCreateAdmissionInput {
  workspaceId: string;
  agentId: string;
  environmentId: string;
  /**
   * True when the Session runs on user-owned compute (self-hosted Environment,
   * local runtime, or an Agent bound to a local daemon). Passed through to
   * the host hook, which decides.
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

/**
 * Optional host admission hook, consulted after the rate limit and daily cap.
 * OSS carries no policy here; a denial's status and body come from the host.
 */
export type SessionCreateAdmissionHookPort = SessionCreateAdmissionPort;

export interface SessionCreateAdmissionLogger {
  warn(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

export interface SessionCreateAdmissionServiceDependencies {
  rateLimiter?: SessionCreateRateLimiterPort;
  dailyCounter?: SessionCreateDailyCounterPort;
  hook?: SessionCreateAdmissionHookPort;
  clock: { now(): Date };
  logger?: SessionCreateAdmissionLogger;
}

export const SESSION_CREATE_RATE_LIMIT_MESSAGE =
  "Too many session creations — wait a minute";

const consoleLogger: SessionCreateAdmissionLogger = {
  warn: (message, fields) => console.warn(`[sessions] ${message}`, fields),
  error: (message, fields) => console.error(`[sessions] ${message}`, fields),
};

/**
 * Shared admission policy: rate limit → daily cap → host hook.
 * The hook fails OPEN on exceptions and malformed denials (logged), matching
 * the legacy behavior.
 */
export class SessionCreateAdmissionService implements SessionCreateAdmissionPort {
  constructor(private readonly dependencies: SessionCreateAdmissionServiceDependencies) {}

  async admit(input: SessionCreateAdmissionInput): Promise<SessionCreateAdmissionDecision> {
    const { rateLimiter, dailyCounter, hook, clock } = this.dependencies;
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

    if (hook) {
      try {
        const decision = await hook.admit(input);
        if (decision.type === "rate_limited") return decision;
        if (
          decision.type === "denied"
          && Number.isInteger(decision.status)
          && decision.status >= 400
          && decision.status <= 599
        ) {
          return { type: "denied", status: decision.status, body: decision.body };
        }
      } catch (err) {
        logger.error("session-create admission hook failed; admitting (fail-open)", {
          op: "session.create.admission_hook_failed",
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

/** Human-readable message for a denial, for surfaces that only carry text. */
export function sessionCreateDenialMessage(status: number, body: unknown): string {
  return body !== null
    && typeof body === "object"
    && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : `Session creation denied by admission hook (${status})`;
}

/** Admission with no adapters configured (self-hosted Node default). */
export const admitAllSessionCreates: SessionCreateAdmissionPort = {
  admit: async () => ({ type: "admitted" }),
};
