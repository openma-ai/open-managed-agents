/**
 * Returns true for a narrow set of fetch/socket lifecycle failures. These
 * can be raised after a proxy response has been handed to the caller, so the
 * process-level failure net must record them without terminating unrelated
 * sessions.
 */
export function isFetchAbortRejection(reason: unknown, seen = new Set<object>()): boolean {
  if (typeof reason !== "object" || reason === null || seen.has(reason)) return false;
  seen.add(reason);

  const error = reason as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (name === "AbortError" || name === "TimeoutError") return true;

  // Undici's post-response body failure shape. Require TypeError so a
  // business error whose message happens to be "terminated" is not ignored.
  if (name === "TypeError" && message === "terminated") return true;

  const code = typeof error.code === "string" ? error.code : "";
  if (FETCH_ABORT_CODES.has(code)) return true;

  // `fetch failed` is only a wrapper; classify it from its cause rather than
  // treating every fetch failure as a routine network lifecycle event.
  if (message === "fetch failed" && isFetchAbortRejection(error.cause, seen)) return true;
  return NETWORK_TERMINATION_MESSAGE.test(message);
}

const FETCH_ABORT_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_ABORTED", "ECONNRESET", "EPIPE"]);
const NETWORK_TERMINATION_MESSAGE = /^(?:socket hang up|premature close|aborted|econnreset|epipe)$/i;
