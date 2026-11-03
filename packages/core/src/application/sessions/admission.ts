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
