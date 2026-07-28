// Better-auth + tenant + membership tables (Node-PG).
//
// PG type rules (per the Drizzle adoption plan):
//   - better-auth tables (user / session / account / verification) use
//     TIMESTAMPTZ columns and a real BOOLEAN for emailVerified —
//     mirrors what `npx @better-auth/cli generate` emits.
//   - tenant.created_at is BIGINT (snake_case). The CF / SQLite side
//     uses camelCase `createdAt` mode:"timestamp". Drift is intentional
//     and called out in the schema rules.
//   - membership.created_at is BIGINT (no _at field shape change).

import {
  bigint,
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// tenant.createdAt/updatedAt: camelCase BIGINT, matching CF / SQLite. The
// pre-Drizzle PG branch had snake_case; we aligned to camelCase so the same
// runtime code (packages/auth-config ensureTenantSqlite) writes one shape
// across both dialects.
export const tenant = pgTable("tenant", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
});

export const user = pgTable("user", {
  id: text("id").primaryKey().notNull(),
  // Better-auth: emailVerified is BOOLEAN on PG (matches schema/src/index.ts
  // applyBetterAuthSchema PG branch).
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  name: text("name").notNull(),
  image: text("image"),
  tenantId: text("tenantId"),
  // PG branch in applyBetterAuthSchema doesn't set NOT NULL/default —
  // mirror that.
  role: text("role"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_session_userId").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [index("idx_account_userId").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey().notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }),
    updatedAt: timestamp("updatedAt", { withTimezone: true }),
  },
  (t) => [index("idx_verification_identifier").on(t.identifier)],
);

export const membership = pgTable(
  "membership",
  {
    user_id: text("user_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    role: text("role").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.tenant_id] }),
    index("idx_membership_user").on(t.user_id),
  ],
);
