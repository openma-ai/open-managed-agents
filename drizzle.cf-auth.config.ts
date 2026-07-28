// drizzle-kit config — CF AUTH_DB (SQLite / D1).
//
// Source: packages/db-schema/src/cf-auth/index.ts (barrel)
// Output: apps/main/migrations/ (consumed by `wrangler d1 migrations apply openma-auth`)
//
// Workflow:
//   pnpm db:generate:cf-auth   → emits new SQL into apps/main/migrations/
//   pnpm db:check:cf-auth      → asserts journal is in sync (CI gate)
//
// drizzle-kit can't push directly to D1; it just emits SQL files that
// wrangler later applies via the d1_migrations table. No dbCredentials
// needed for the generate step.

import type { Config } from "drizzle-kit";

export default {
  dialect: "sqlite",
  schema: "./packages/db-schema/src/cf-auth/index.ts",
  out: "./apps/main/migrations",
  verbose: false,
  strict: true,
} satisfies Config;
