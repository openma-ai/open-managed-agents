import { getLogger, NoopLogger, type Logger } from "@open-managed-agents/observability";
import { handleProcessFailure } from "./db-unhandled-rejection";

/** Explicit evidence that process-wide coordination can no longer be trusted.
 * Ordinary provider, input and operation errors must never use this marker. */
export class ProcessInvariantError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options); this.name = "ProcessInvariantError";
  }
}

export function hasProcessInvariantFailure(error: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return false;
  seen.add(error);
  if (error instanceof ProcessInvariantError) return true;
  if (error instanceof AggregateError && error.errors.some(item => hasProcessInvariantFailure(item, seen))) return true;
  return error instanceof Error && hasProcessInvariantFailure(error.cause, seen);
}

export function terminateForInvariant(error: unknown, exit?: (code: number) => void): void {
  let logger: Logger = new NoopLogger();
  try { logger = getLogger("process-invariant"); } catch { /* exit still required */ }
  handleProcessFailure("uncaught_exception", error, { logger }, exit);
}
