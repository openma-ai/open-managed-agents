// Local ACP runtime tables (CF SQLite / D1).
//
// Tables:
//   runtimes               — one row per registered laptop/VM running
//                            `oma bridge daemon`. Hot heartbeat target.
//   runtime_tokens         — bearer credentials (sk_machine_*).
//                            token_hash = sha256(plaintext) hex.
//   connect_runtime_codes  — short-TTL one-time codes for the browser →
//                            CLI handshake.
//
// Sources:
//   apps/main/migrations/_archive/0010_runtimes.sql
//   apps/main/migrations/_archive/0011_runtime_local_skills.sql
//     (adds local_skills_json NOT NULL DEFAULT '{}')

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const runtimes = sqliteTable(
  "runtimes",
  {
    id: text("id").primaryKey().notNull(),
    owner_user_id: text("owner_user_id").notNull(),
    owner_tenant_id: text("owner_tenant_id").notNull(),
    machine_id: text("machine_id").notNull(),
    hostname: text("hostname").notNull(),
    os: text("os").notNull(),
    // JSON array of agent ids — plain TEXT, parsed in adapter.
    agents_json: text("agents_json").notNull().default("[]"),
    version: text("version").notNull(),
    status: text("status").notNull().default("offline"),
    last_heartbeat: integer("last_heartbeat"),
    created_at: integer("created_at").notNull(),
    // Added 0011. JSON object: { "<agent-id>": [...] }.
    local_skills_json: text("local_skills_json").notNull().default("{}"),
  },
  (t) => [
    uniqueIndex("idx_runtimes_user_machine").on(t.owner_user_id, t.machine_id),
    index("idx_runtimes_tenant").on(t.owner_tenant_id, t.created_at),
  ],
);

export const runtime_tokens = sqliteTable(
  "runtime_tokens",
  {
    id: text("id").primaryKey().notNull(),
    runtime_id: text("runtime_id").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    created_by_user_id: text("created_by_user_id").notNull(),
    revoked_at: integer("revoked_at"),
    last_used_at: integer("last_used_at"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("idx_runtime_tokens_runtime").on(t.runtime_id, t.revoked_at)],
);

export const connect_runtime_codes = sqliteTable(
  "connect_runtime_codes",
  {
    code: text("code").primaryKey().notNull(),
    user_id: text("user_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    state: text("state").notNull(),
    expires_at: integer("expires_at").notNull(),
    used_at: integer("used_at"),
  },
  (t) => [index("idx_connect_runtime_codes_expires").on(t.expires_at)],
);
