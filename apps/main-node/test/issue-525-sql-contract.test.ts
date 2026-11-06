import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema } from "@open-managed-agents/session-runtime-sql/coordination";
import { ensureSessionSandboxBindingSchema } from "@open-managed-agents/session-runtime-sql/sandbox-binding";
import { issue525SqlContract } from "./helpers/issue-525-sql-contract";

issue525SqlContract("sqlite", async run => {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await ensureSessionExecutionCoordinatorSchema(sql);
  await ensureSessionSandboxBindingSchema(sql, "sqlite");
  await run(sql, sql);
});
