import { NoopLogger } from "@open-managed-agents/observability";
import { CasConflict } from "@open-managed-agents/sql-client";
import { installDbUnhandledRejectionNet } from "../../../../packages/control-plane-node/src/lib/db-unhandled-rejection.js";

const logger = new NoopLogger();
logger.fatal = (obj) => {
  const fields = typeof obj === "string" ? { message: obj } : obj;
  console.log(JSON.stringify({ msg: "process.failure", ...fields }));
};

installDbUnhandledRejectionNet({
  logger,
  exit: (code) => process.exit(code),
});

Promise.reject(new CasConflict({
  op: "session_execution.settle",
  sessionId: "session_fatal",
  cause: new Error("conditional update matched no row"),
}));
