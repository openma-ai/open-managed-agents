// drizzle-kit config — CF INTEGRATIONS_DB (SQLite / D1).
//
// Source: packages/db-schema/src/cf-integrations/index.ts (barrel)
// Output: apps/main/migrations-integrations/ (consumed by
//         `wrangler d1 migrations apply openma-integrations`)

import type { Config } from "drizzle-kit";

export default {
  dialect: "sqlite",
  schema: "./packages/db-schema/src/cf-integrations/index.ts",
  out: "./apps/main/migrations-integrations",
  verbose: false,
  strict: true,
} satisfies Config;
