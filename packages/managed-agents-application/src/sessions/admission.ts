/**
 * Session-create admission.
 *
 * Every path that persists a new Session (POST /v1/sessions, Deployment
 * launches) runs `SessionCreateAdmissionService.admit` BEFORE anything is
 * persisted or any runtime work is admitted. The policy (order of checks,
 * fail-open on hook errors, rejection shapes) lives here so Cloudflare and
 * Node share one semantics; hosts only provide the storage/binding adapters
 * and an optional, policy-free admission hook. The Port types live in
 * @openma/core.
 */

import type {
  SessionCreateAdmissionDecision,
  SessionCreateAdmissionHookPort,
  SessionCreateAdmissionInput,
  SessionCreateAdmissionPort,
  SessionCreateDailyCounterPort,
  SessionCreateRateLimiterPort,
} from "@openma/core";

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
