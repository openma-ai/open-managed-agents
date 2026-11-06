import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { beforeAll, afterAll } from "vitest";
import { openNodeDatabase } from "../src/database";
import { ensureSessionExecutionClaimLockSchema } from "@open-managed-agents/session-runtime-sql/coordination";
import { ensureSessionSandboxBindingSchema } from "@open-managed-agents/session-runtime-sql/sandbox-binding";
import { clearIssue525Fixture, issue525SqlContract } from "./helpers/issue-525-sql-contract";

let container: StartedPostgreSqlContainer | undefined;
let database: Awaited<ReturnType<typeof openNodeDatabase>>;
let other: Awaited<ReturnType<typeof openNodeDatabase>>;
beforeAll(async () => {
  // Required real engine: absence of Docker fails, never silently skips.
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const config = { kind: "postgres" as const, url: container.getConnectionUri() };
  database = await openNodeDatabase(config);
  other = await openNodeDatabase(config, { migrate: false });
  await ensureSessionExecutionClaimLockSchema(database.sql, "postgres");
  await ensureSessionSandboxBindingSchema(database.sql, "postgres");
}, 180_000);
afterAll(async () => {
  await other?.stop?.(); await database?.stop?.(); await container?.stop();
}, 60_000);

issue525SqlContract("postgres", async run => {
  await clearIssue525Fixture(database.sql);
  await run(database.sql, other.sql);
});

