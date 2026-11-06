import type { Logger, MetricsRecorder } from "@open-managed-agents/observability";
import { processFailureRecord } from "@open-managed-agents/sql-client";

export interface DbUnhandledRejectionNet {
  logger: Logger;
  metrics?: MetricsRecorder;
  /** Defaults to process.exit. Tests pass a stub. */
  exit?: (code: number) => void;
}

let installed = false;

/**
 * Last line of defence. Background loops must already catch DB errors.
 * Every unowned rejection/exception is fatal. Recoverable DB failures belong
 * inside their owning operation, never at this process-wide last resort.
 * https://nodejs.org/docs/latest-v24.x/api/process.html#warning-using-uncaughtexception-correctly
 */
export function installDbUnhandledRejectionNet(
  deps: DbUnhandledRejectionNet,
): () => void {
  if (installed) return () => {};
  installed = true;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const onRejection = (reason: unknown) => {
    handleProcessFailure("unhandled_rejection", reason, deps, exit);
  };
  const onException = (error: Error) => {
    handleProcessFailure("uncaught_exception", error, deps, exit);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
    installed = false;
  };
}

export function handleProcessFailure(
  kind: "unhandled_rejection" | "uncaught_exception",
  reason: unknown,
  deps: DbUnhandledRejectionNet,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  try {
    const record = processFailureRecord(kind, reason);
    try {
      deps.logger.fatal({ ...record, op: record.op }, JSON.stringify({ msg: "process.failure", ...record }));
    } catch {
      // Logging is best effort at the process-fatal boundary.
    }
    try {
      deps.metrics?.counter("oma_db_unhandled_rejections_total", 1, { tag: record.errorTag });
    } catch {
      // A broken recorder cannot turn a fatal error into continued execution.
    }
  } catch {
    // Even malformed failure objects must not prevent termination.
  } finally {
    exit(1);
  }
}
