// Local ACP runtime tables (Node-PG variant of cf-auth/runtimes).

import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const runtimes = pgTable(
  "runtimes",
  {
    id: text("id").primaryKey().notNull(),
    owner_user_id: text("owner_user_id").notNull(),
    owner_tenant_id: text("owner_tenant_id").notNull(),
    machine_id: text("machine_id").notNull(),
    hostname: text("hostname").notNull(),
    os: text("os").notNull(),
    agents_json: text("agents_json").notNull().default("[]"),
    version: text("version").notNull(),
    status: text("status").notNull().default("offline"),
    last_heartbeat: bigint("last_heartbeat", { mode: "number" }),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    local_skills_json: text("local_skills_json").notNull().default("{}"),
  },
  (t) => [
    uniqueIndex("idx_runtimes_user_machine").on(t.owner_user_id, t.machine_id),
    index("idx_runtimes_tenant").on(t.owner_tenant_id, t.created_at),
  ],
);

export const runtime_tokens = pgTable(
  "runtime_tokens",
  {
    id: text("id").primaryKey().notNull(),
    runtime_id: text("runtime_id").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    created_by_user_id: text("created_by_user_id").notNull(),
    revoked_at: bigint("revoked_at", { mode: "number" }),
    last_used_at: bigint("last_used_at", { mode: "number" }),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_runtime_tokens_runtime").on(t.runtime_id, t.revoked_at)],
);

export const connect_runtime_codes = pgTable(
  "connect_runtime_codes",
  {
    code: text("code").primaryKey().notNull(),
    user_id: text("user_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    state: text("state").notNull(),
    expires_at: bigint("expires_at", { mode: "number" }).notNull(),
    used_at: bigint("used_at", { mode: "number" }),
  },
  (t) => [index("idx_connect_runtime_codes_expires").on(t.expires_at)],
);
