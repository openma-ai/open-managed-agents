// Linear integration tables (CF INTEGRATIONS_DB / D1 SQLite).
//
// Source of truth: apps/main/migrations-integrations/0001_consolidated.sql
// (the squashed baseline; pre-squash sources in _archive/0001..0006).
//
// Naming follows DB-column snake_case throughout (matches cf-router/sharding.ts
// pattern; consumers $infer types directly from these tables).
//
// Timestamps are raw INTEGER (ms-epoch). Cipher columns hold AES-GCM bytes
// as base64 — opaque TEXT to the DB. JSON blobs (capabilities, payload_json)
// are TEXT and parsed at the app layer.

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── linear_apps ──────────────────────────────────────────────────────────
// Per-publication Linear App credentials (A1 mode only). Each row pairs with
// at most one linear_publications row in mode='full'. publication_id is
// nullable to support the legacy A1 install flow (credentials before pub).
// New installs go through linear_publications.client_id/client_secret_cipher
// directly (publication-first flow); this table stays for legacy rows.
export const linear_apps = sqliteTable(
  "linear_apps",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").unique(),
    client_id: text("client_id").notNull(),
    client_secret_cipher: text("client_secret_cipher").notNull(),
    webhook_secret_cipher: text("webhook_secret_cipher").notNull(),
    created_at: integer("created_at").notNull(), // ms epoch
  },
  (t) => [index("idx_linear_apps_tenant").on(t.tenant_id)],
);

// ─── linear_installations ────────────────────────────────────────────────
// Workspace installations. install_kind: 'shared' (B+) | 'dedicated' (A1) |
// 'personal_token' (PR #21). vault_id holds the bearer credential vault for
// the external API.
export const linear_installations = sqliteTable(
  "linear_installations",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    provider_id: text("provider_id").notNull(),
    workspace_id: text("workspace_id").notNull(),
    workspace_name: text("workspace_name").notNull(),
    install_kind: text("install_kind").notNull(),
    app_id: text("app_id"),
    access_token_cipher: text("access_token_cipher").notNull(),
    refresh_token_cipher: text("refresh_token_cipher"),
    scopes: text("scopes").notNull(),
    bot_user_id: text("bot_user_id").notNull(),
    created_at: integer("created_at").notNull(),
    revoked_at: integer("revoked_at"),
    vault_id: text("vault_id"),
  },
  (t) => [
    // Active-install UNIQUE: only one non-revoked row per
    // (provider, workspace, install_kind, app). COALESCE pattern
    // hits drizzle-kit issue #3350 on emit (backticks around the
    // sql expression); Phase 3 hand-fixes the migration SQL.
    uniqueIndex("idx_linear_installations_active")
      .on(
        t.provider_id,
        t.workspace_id,
        t.install_kind,
        sql`COALESCE(${t.app_id}, '')`,
      )
      .where(sql`${t.revoked_at} IS NULL`),
    index("idx_linear_installations_user").on(t.user_id, t.provider_id),
    index("idx_linear_installations_tenant").on(
      t.tenant_id,
      sql`${t.created_at} DESC`,
    ),
  ],
);

// ─── linear_publications ─────────────────────────────────────────────────
// Agent ↔ workspace bindings. The publication-first install flow stages
// credentials directly on the row (client_id, *_cipher, vault_id) before
// the OAuth callback wires installation_id; status flips through
// pending_setup → credentials_filled → live.
export const linear_publications = sqliteTable(
  "linear_publications",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id").notNull(),
    installation_id: text("installation_id")
      .notNull()
      .references(() => linear_installations.id),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    persona_name: text("persona_name").notNull(),
    persona_avatar_url: text("persona_avatar_url"),
    capabilities: text("capabilities").notNull(), // JSON
    session_granularity: text("session_granularity").notNull(),
    created_at: integer("created_at").notNull(),
    unpublished_at: integer("unpublished_at"),
    environment_id: text("environment_id"),
    // 0004_linear_publication_first.sql: pre-OAuth credential staging
    client_id: text("client_id"),
    client_secret_cipher: text("client_secret_cipher"),
    webhook_secret_cipher: text("webhook_secret_cipher"),
    signing_secret_cipher: text("signing_secret_cipher"),
    vault_id: text("vault_id"),
  },
  (t) => [
    index("idx_linear_publications_installation").on(t.installation_id),
    index("idx_linear_publications_user_agent").on(t.user_id, t.agent_id),
    index("idx_linear_publications_tenant").on(
      t.tenant_id,
      sql`${t.created_at} DESC`,
    ),
  ],
);

// ─── linear_events ────────────────────────────────────────────────────────
// Merged dedup + audit + queue. delivery_id PK gives webhook dedup via
// INSERT OR IGNORE; payload_json + processed_at form the async dispatch
// queue role; error column carries the audit message when the handler
// declines to act. See LinearEventStore in integrations-core.
export const linear_events = sqliteTable(
  "linear_events",
  {
    delivery_id: text("delivery_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    installation_id: text("installation_id").notNull(),
    publication_id: text("publication_id"),
    event_type: text("event_type").notNull(),
    received_at: integer("received_at").notNull(),
    session_id: text("session_id"),
    error: text("error"),
    // queue role
    event_kind: text("event_kind"),
    payload_json: text("payload_json"), // JSON
    processed_at: integer("processed_at"),
    processed_session_id: text("processed_session_id"),
  },
  (t) => [
    index("idx_linear_events_received").on(sql`${t.received_at} DESC`),
    index("idx_linear_events_tenant").on(
      t.tenant_id,
      sql`${t.received_at} DESC`,
    ),
    // Drain hot path: actionable + not yet processed. Partial keeps
    // scan O(queue depth).
    index("idx_linear_events_unprocessed")
      .on(t.received_at)
      .where(
        sql`${t.payload_json} IS NOT NULL AND ${t.processed_at} IS NULL`,
      ),
    index("idx_linear_events_publication").on(
      t.publication_id,
      sql`${t.received_at} DESC`,
    ),
  ],
);

// ─── linear_setup_links ───────────────────────────────────────────────────
// Setup link tokens for non-admin handoff (publisher → workspace admin).
export const linear_setup_links = sqliteTable(
  "linear_setup_links",
  {
    token: text("token").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").notNull(),
    created_by: text("created_by").notNull(),
    expires_at: integer("expires_at").notNull(),
    used_at: integer("used_at"),
    used_by_email: text("used_by_email"),
  },
  (t) => [
    index("idx_linear_setup_links_expires").on(t.expires_at),
    index("idx_linear_setup_links_tenant").on(t.tenant_id),
  ],
);

// ─── linear_issue_sessions ────────────────────────────────────────────────
// Issue ↔ session mapping for per_issue session granularity. Composite PK.
export const linear_issue_sessions = sqliteTable(
  "linear_issue_sessions",
  {
    publication_id: text("publication_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    issue_id: text("issue_id").notNull(),
    session_id: text("session_id").notNull(),
    status: text("status").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.publication_id, t.issue_id] }),
    index("idx_linear_issue_sessions_active").on(t.publication_id, t.status),
    index("idx_linear_issue_sessions_tenant").on(t.tenant_id),
  ],
);

// ─── linear_authored_comments ─────────────────────────────────────────────
// Tracks comments the bot authored via the OMA Linear MCP `linear_post_comment`
// tool. parentId on a Linear webhook resolves here → omaSessionId → dispatch.
export const linear_authored_comments = sqliteTable(
  "linear_authored_comments",
  {
    comment_id: text("comment_id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    oma_session_id: text("oma_session_id").notNull(),
    issue_id: text("issue_id").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_linear_authored_comments_session").on(t.oma_session_id),
    index("idx_linear_authored_comments_tenant").on(t.tenant_id),
  ],
);

// ─── linear_dispatch_rules ────────────────────────────────────────────────
// Autopilot dispatch rules (PR #21). enabled is a 0/1 flag. The sweep cron
// scans (enabled, last_polled_at) ASC to round-robin across rules.
export const linear_dispatch_rules = sqliteTable(
  "linear_dispatch_rules",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled").notNull().default(1),
    filter_label: text("filter_label"),
    filter_states: text("filter_states"),
    filter_project_id: text("filter_project_id"),
    max_concurrent: integer("max_concurrent").notNull().default(5),
    poll_interval_seconds: integer("poll_interval_seconds")
      .notNull()
      .default(600),
    last_polled_at: integer("last_polled_at"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    index("idx_linear_dispatch_rules_sweep").on(t.enabled, t.last_polled_at),
    index("idx_linear_dispatch_rules_publication").on(t.publication_id),
    index("idx_linear_dispatch_rules_tenant").on(
      t.tenant_id,
      sql`${t.created_at} DESC`,
    ),
  ],
);
