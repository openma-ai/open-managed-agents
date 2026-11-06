import { writeSync } from "node:fs";
import { NoopLogger } from "@open-managed-agents/observability";
import { CasConflict, ConnectionLost, Timeout } from "@open-managed-agents/sql-client";
import { installDbUnhandledRejectionNet } from "../../../../packages/control-plane-node/src/lib/db-unhandled-rejection.js";

const mode = process.argv[2] ?? "cas";
const logger = new NoopLogger();
logger.fatal = (obj) => {
  if (mode === "logger") throw new Error("logger failed");
  const fields = typeof obj === "string" ? { message: obj } : obj;
  writeSync(1, `${JSON.stringify({ msg: "process.failure", ...fields })}\n`);
};

installDbUnhandledRejectionNet({
  logger,
  ...(mode === "metrics" ? { metrics: { counter() { throw new Error("metrics failed"); } } as never } : {}),
});
writeSync(1, "fixture-ready\n");
const fields = { op: "session_execution.settle", sessionId: "session_fatal" };
const failure = mode === "cas" ? new CasConflict(fields)
  : mode === "connection" ? new ConnectionLost(fields) : new Timeout(fields);
// Continuing past an unowned failure must be observable as an incorrect exit 0.
setTimeout(() => { writeSync(1, "survived\n"); process.exit(0); }, 100);
if (mode === "exception") setImmediate(() => { throw failure; });
else void Promise.reject(failure);
