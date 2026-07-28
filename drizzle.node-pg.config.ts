// drizzle-kit config — Node-PG (PostgreSQL).
//
// Source: packages/db-schema/src/node-pg/index.ts (union of all CF schemas
//         with PG-typed columns)
// Output: apps/main-node/migrations/
//
// Note: apps/main-node/migrations/ does NOT exist on this branch yet —
// the migration runner + initial baseline live on the rl-logprobs branch
// and have not landed in master. Phase 3 of this Drizzle adoption will
// create the directory and emit the first 0001_consolidated.sql via
// `pnpm db:generate:node-pg`.
//
// dbCredentials let `pnpm db:check:node-pg` verify journal consistency
// against a live PG (testcontainers in CI, dev DB locally).

import type { Config } from "drizzle-kit";

export default {
  dialect: "postgresql",
  schema: "./packages/db-schema/src/node-pg/index.ts",
  out: "./apps/main-node/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://oma:oma@localhost:5432/oma",
  },
  verbose: false,
  strict: true,
} satisfies Config;
