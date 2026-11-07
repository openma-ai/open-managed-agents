import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { beforeAll, afterAll } from "vitest";
import { openNodeDatabase } from "../src/database";
import { ensureSessionExecutionClaimLockSchema } from "@open-managed-agents/session-runtime-sql/coordination";
import { ensureSessionSandboxBindingSchema } from "@open-managed-agents/session-runtime-sql/sandbox-binding";
import { clearIssue525Fixture, issue525SqlContract } from "./helpers/issue-525-sql-contract";

let container: StartedMySqlContainer | undefined;
let database: Awaited<ReturnType<typeof openNodeDatabase>>;
let other: Awaited<ReturnType<typeof openNodeDatabase>>;
beforeAll(async () => {
  // Required real engine: absence of Docker fails, never silently skips.
  container = await new MySqlContainer("mysql:8.4").start();
  const config = { kind: "mysql" as const, url: container.getConnectionUri() };
  database = await openNodeDatabase(config);
  other = await openNodeDatabase(config, { migrate: false });
  await ensureSessionExecutionClaimLockSchema(database.sql, "mysql");
  await ensureSessionSandboxBindingSchema(database.sql, "mysql");
}, 180_000);
afterAll(async () => {
  await other?.stop?.(); await database?.stop?.(); await container?.stop();
}, 60_000);

issue525SqlContract("mysql", async run => {
  await clearIssue525Fixture(database.sql);
  await run(database.sql, other.sql);
});

