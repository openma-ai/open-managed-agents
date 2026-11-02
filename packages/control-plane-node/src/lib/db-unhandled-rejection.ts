import type { Logger, MetricsRecorder } from "@open-managed-agents/observability";
import {
  isLeaseSafeFailure,
  processFailureRecord,
} from "@open-managed-agents/sql-client";

export interface DbUnhandledRejectionNet {
  logger: Logger;
  metrics?: MetricsRecorder;
  /** Defaults to process.exit. Tests pass a stub. */
  exit?: (code: number) => void;
}

let installed = false;

/**
 * Last line of defence. Background loops must already catch DB errors.
 * A stray rejection still logs one structured line. Driver blips and
 * application deadlines do not exit; every other rejection does, outside tests.
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
  const record = processFailureRecord(kind, reason);
  const line = JSON.stringify({ msg: "process.failure", ...record });
  deps.logger.fatal({ ...record, op: record.op }, line);
  deps.metrics?.counter("oma_db_unhandled_rejections_total", 1, { tag: record.errorTag });
  if (isLeaseSafeFailure(reason)) return;
  if (process.env.NODE_ENV === "test") return;
  exit(1);
}
