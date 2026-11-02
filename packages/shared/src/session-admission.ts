/**
 * Generic Cloudflare injection seam for Session work admission.
 *
 * A deployment may bind `SESSION_ADMISSION` to any worker entrypoint that
 * implements {@link SessionAdmissionHook}. OSS ships no implementation and
 * no policy: when unbound, or when the hook throws, work is admitted
 * (fail-open). A denial's status and body are returned to clients verbatim.
 */

export type SessionAdmissionHookKind = "turn" | "thread_start" | "model_request";

export interface SessionAdmissionHookInput {
  kind: SessionAdmissionHookKind;
  workspaceId: string;
  sessionId?: string;
  agentId?: string;
  environmentId?: string;
  isLocalRuntime: boolean;
}

export type SessionAdmissionHookDecision =
  | { type: "allowed" }
  | { type: "denied"; status: number; body: unknown };

export interface SessionAdmissionHook {
  admit(input: SessionAdmissionHookInput): Promise<SessionAdmissionHookDecision>;
}

/** Call the optional hook; unbound, malformed or failing hooks admit. */
export async function admitViaSessionAdmissionHook(
  hook: SessionAdmissionHook | undefined | null,
  input: SessionAdmissionHookInput,
): Promise<SessionAdmissionHookDecision> {
  if (!hook) return { type: "allowed" };
  try {
    const decision = await hook.admit(input);
    if (
      decision &&
      decision.type === "denied" &&
      Number.isInteger(decision.status) &&
      decision.status >= 400 &&
      decision.status <= 599
    ) {
      return { type: "denied", status: decision.status, body: decision.body };
    }
  } catch (err) {
    console.error(
      `[session-admission] hook failed (${input.kind}), admitting: ${(err as Error)?.message ?? err}`,
    );
  }
  return { type: "allowed" };
}

/** Raised by runtimes when a host hook denies a session-thread start. */
export class SessionAdmissionDeniedError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const detail =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Session work denied by admission hook (${status})`;
    super(detail);
    this.name = "SessionAdmissionDeniedError";
    this.status = status;
    this.body = body;
  }
}
