// The Postgres database component end to end: the adapter package connects,
// the Node baseline migrates (twice, to prove idempotence), and Better Auth
// signs a user up through the auth database the adapter opens.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBetterAuthComponent } from "../src/auth/node-auth.js";
import { loadNodeConfig } from "../src/config.js";
import { migrateNodeDatabase, openNodeDatabase } from "../src/database.js";

const BASE = "http://localhost:8080";
// Distinct from the default user and database names, so the description check below is meaningful.
const PASSWORD = "pg-s3cret-7f3a";
let container: StartedPostgreSqlContainer;
let dir: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").withPassword(PASSWORD).start();
  dir = mkdtempSync(join(tmpdir(), "oma-database-postgres-"));
}, 180_000);

afterAll(async () => {
  await container?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe("Postgres database component", () => {
  it("migrates idempotently and backs Better Auth sign-up", async () => {
    const config = loadNodeConfig({
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
      PUBLIC_BASE_URL: BASE,
      DATABASE_URL: container.getConnectionUri(),
      AUTH_DATABASE_PATH: join(dir, "unused-auth.db"),
      SANDBOX_WORKDIR: join(dir, "sandboxes"),
      MEMORY_BLOB_DIR: join(dir, "memories"),
      FILES_BLOB_DIR: join(dir, "files"),
      SESSION_OUTPUTS_DIR: join(dir, "outputs"),
      MEMORY_QUEUE: "disabled",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
      ANTHROPIC_API_KEY: "unused",
    });
    expect(config.database.kind).toBe("postgres");

    const database = await openNodeDatabase(config.database);
    const auth = await createBetterAuthComponent({ config, database, email: null });
    try {
      expect(database.dialect).toBe("postgres");
      expect(database.description).not.toContain(PASSWORD);
      await migrateNodeDatabase(database);
      expect(auth.description).toBe("better-auth-pg");

      const signUp = await auth.handler(new Request(`${BASE}/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: "ada@example.com", password: "correct-horse-battery", name: "Ada" }),
      }));
      expect(signUp.status).toBe(200);
      const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

      const session = await auth.resolveSession(new Headers({ cookie }));
      expect(session).toMatchObject({ email: "ada@example.com", name: "Ada" });
      expect(await auth.findUser(session!.userId)).toEqual({ name: "Ada", email: "ada@example.com" });

      // Sign-up created the user's workspace in the control-plane database.
      const membership = await database.sql
        .prepare("SELECT tenant_id FROM membership WHERE user_id = ?")
        .bind(session!.userId)
        .first<{ tenant_id: string }>();
      expect(membership?.tenant_id).toBeTruthy();
    } finally {
      await auth.stop?.();
      await database.stop?.();
    }
  });
});
