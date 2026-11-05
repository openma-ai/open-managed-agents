/**
 * Network-abort rejection taxonomy for the process-failure net.
 *
 * The osbtest crash (fork#17): an in-flight MCP proxy fetch whose socket died
 * after the Response had already resolved produced an undici internal
 * rejection (`TypeError: terminated`, `Fetch.onAborted`) that no application
 * await chain observes — only the process-level `unhandledRejection` net can
 * catch it. Such network lifecycle terminations are routine for long-lived
 * proxy connections and must not exit the process (the structured fatal log
 * still fires, so the evidence chain stays intact).
 */

/** Whether this rejection is a routine fetch/socket termination. */
export function isFetchAbortRejection(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  const error = reason as { name?: string; message?: string; code?: string | number; cause?: unknown };
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const code = typeof error.code === "string" ? error.code : undefined;
  if (code?.startsWith("UND_ERR")) return true;
  const message = typeof error.message === "string" ? error.message : "";
  if (message === "terminated") return true;
  if (message === "fetch failed") return isFetchAbortRejection(error.cause);
  const text = [message, code ?? ""].join(" ");
  return NETWORK_TERMINATION_PATTERN.test(text);
}

const NETWORK_TERMINATION_PATTERN = /socket hang up|econnreset|epipe|premature close|aborted/i;
