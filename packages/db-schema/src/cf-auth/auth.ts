// Better-auth + tenant + membership tables (CF SQLite / D1).
//
// Tables:
//   tenant       — tenant root row. createdAt / updatedAt are camelCase
//                  (better-auth convention) and use Drizzle's
//                  `mode: "timestamp"` to match the existing 60-line
//                  schema in apps/main/src/db/schema.ts.
//   membership   — user ↔ tenant N-to-N with role. snake_case columns
//                  with raw INTEGER unix-second timestamps.
//   user / session / account / verification — better-auth library tables.
//                  Library mandates camelCase. session.userId and
//                  account.userId reference user.id with cascade delete
//                  (the only FKs in this whole schema — better-auth uses
//                  them).
//
// Source: apps/main/migrations/_archive/0001_schema.sql (auth section)
// + apps/main/migrations/_archive/0005_membership.sql.

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenant = sqliteTable("tenant", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  // camelCase + mode:"timestamp" matches the better-auth tenant row
  // and apps/main/src/db/schema.ts. PG variant uses snake_case BIGINT —
  // drift is intentional, will be reconciled in a later phase.
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const user = sqliteTable("user", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  // emailVerified is a real boolean per better-auth; SQLite stores 0/1.
  emailVerified: integer("emailVerified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  // No FK constraint here — better-auth deletes via its own cascades and
  // the project convention is "no DB FKs except where better-auth
  // mandates them" (see _archive/0001_schema.sql header).
  tenantId: text("tenantId"),
  role: text("role").notNull().default("member"), // owner | admin | member
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey().notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey().notNull(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey().notNull(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  // Better-auth allows nulls on these — see baseline 0001_schema.sql.
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

export const membership = sqliteTable(
  "membership",
  {
    user_id: text("user_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    // owner | admin | member
    role: text("role").notNull().default("member"),
    // Raw integer (unix seconds in the original migration; ms in newer
    // writes — adapter normalizes). NOT mode:"timestamp" — keep parity
    // with the existing CF baseline.
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.tenant_id] }),
    index("idx_membership_user").on(t.user_id),
    index("idx_membership_tenant").on(t.tenant_id),
  ],
);
