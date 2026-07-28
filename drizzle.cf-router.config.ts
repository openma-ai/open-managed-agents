// drizzle-kit config — CF ROUTER_DB (SQLite / D1).
//
// Source: packages/db-schema/src/cf-router/index.ts (barrel)
// Output: apps/main/migrations-router/ (consumed by
//         `wrangler d1 migrations apply openma-router`)
//
// Note: ROUTER_DB is multi-shard prod only. Single-D1 self-host
// deployments don't bind ROUTER_DB; env.ROUTER_DB falls back to
// env.AUTH_DB and the shard tables exist (harmlessly) inside AUTH_DB.

import type { Config } from "drizzle-kit";

export default {
  dialect: "sqlite",
  schema: "./packages/db-schema/src/cf-router/index.ts",
  out: "./apps/main/migrations-router",
  verbose: false,
  strict: true,
} satisfies Config;
