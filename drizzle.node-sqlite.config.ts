// drizzle-kit config — Node-SQLite (better-sqlite3 self-host).
//
// Source: packages/db-schema/src/node-sqlite/index.ts (re-exports the
//         cf-auth + cf-integrations + cf-router SQLite schemas as one
//         flat barrel — Node self-host puts everything in one .db file)
// Output: apps/main-node/migrations-sqlite/
//
// Why a separate baseline from the 3 CF dirs:
//   The CF deploy splits the same logical schema across 3 D1 bindings.
//   Node self-host puts it all in one SQLite file, so we want one
//   migrate(db, { migrationsFolder }) call, not three. drizzle-kit emits
//   a single 0001_consolidated.sql here that's the union of the CF dirs.

import type { Config } from "drizzle-kit";

export default {
  dialect: "sqlite",
  schema: "./packages/db-schema/src/node-sqlite/index.ts",
  out: "./apps/main-node/migrations-sqlite",
  verbose: false,
  strict: true,
} satisfies Config;
