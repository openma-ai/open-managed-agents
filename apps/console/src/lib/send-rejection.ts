import { managedSendRejection } from "@openma/common/protocol/managed";

/**
 * Official CMA: a `user.message` while the session is idle with
 * `stop_reason: requires_action` (or `budget_reached`) is a 400 settle-only
 * rejection. The message was NOT accepted — never show it as queued. Keep the
 * user's text in the composer so they can resend after the action settles.
 *
 * Returns the composer notice to show, or null when the failure is not a
 * settle-only rejection.
 */
export function settleOnlySendFailureNotice(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: unknown; code?: unknown; message?: unknown; retainComposer?: unknown };
  if (e.retainComposer === true) {
    return "Waiting on a tool action. Your message is still in the composer: send it again after the action settles.";
  }
  if (typeof e.status !== "number") return null;
  const rejection = managedSendRejection(e.status, {
    error: {
      type: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
    },
  });
  return rejection?.settleOnly
    ? "Waiting on a tool action. Your message is still in the composer: send it again after the action settles."
    : null;
}
