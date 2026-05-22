// Slack integration tables (CF INTEGRATIONS_DB / D1 SQLite).
//
// Source of truth: apps/main/migrations-integrations/0001_consolidated.sql
// (the squashed baseline; pre-squash sources in _archive/0001+0002).

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── slack_apps ───────────────────────────────────────────────────────────
// Per-publication Slack App credentials. Each row pairs with at most one
// slack_publications row in mode='full'. Legacy table — new installs write
// credentials directly onto slack_publications (publication-first flow).
export const slack_apps = sqliteTable(
  "slack_apps",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").unique(),
    client_id: text("client_id").notNull(),
    client_secret_cipher: text("client_secret_cipher").notNull(),
    signing_secret_cipher: text("signing_secret_cipher").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("idx_slack_apps_tenant").on(t.tenant_id)],
);

// ─── slack_installations ──────────────────────────────────────────────────
// Workspace installations for Slack. user_token_cipher carries the optional
// xoxp- token (when user-scope was requested at install). bot_vault_id is
// distinct from vault_id (bot vs user credential).
export const slack_installations = sqliteTable(
  "slack_installations",
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
    user_token_cipher: text("user_token_cipher"),
    scopes: text("scopes").notNull(),
    bot_user_id: text("bot_user_id").notNull(),
    vault_id: text("vault_id"),
    bot_vault_id: text("bot_vault_id"),
    created_at: integer("created_at").notNull(),
    revoked_at: integer("revoked_at"),
  },
  (t) => [
    // Active-install UNIQUE — see linear.ts for the COALESCE caveat.
    uniqueIndex("idx_slack_installations_active")
      .on(
        t.provider_id,
        t.workspace_id,
        t.install_kind,
        sql`COALESCE(${t.app_id}, '')`,
      )
      .where(sql`${t.revoked_at} IS NULL`),
    index("idx_slack_installations_user").on(t.user_id, t.provider_id),
    index("idx_slack_installations_tenant").on(t.tenant_id),
  ],
);

// ─── slack_publications ───────────────────────────────────────────────────
// Agent ↔ workspace bindings. environment_id is NOT NULL here (unlike
// linear/github where it's nullable). Publication-first columns (0002):
// client_*, signing_secret_cipher, slack_app_id (the Slack-side App id,
// e.g. A07ABC...).
export const slack_publications = sqliteTable(
  "slack_publications",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id").notNull(),
    installation_id: text("installation_id")
      .notNull()
      .references(() => slack_installations.id),
    environment_id: text("environment_id").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    persona_name: text("persona_name").notNull(),
    persona_avatar_url: text("persona_avatar_url"),
    capabilities: text("capabilities").notNull(), // JSON
    session_granularity: text("session_granularity").notNull(),
    created_at: integer("created_at").notNull(),
    unpublished_at: integer("unpublished_at"),
    // 0002_slack_publication_first.sql: pre-OAuth credential staging
    client_id: text("client_id"),
    client_secret_cipher: text("client_secret_cipher"),
    signing_secret_cipher: text("signing_secret_cipher"),
    slack_app_id: text("slack_app_id"),
  },
  (t) => [
    index("idx_slack_publications_installation").on(t.installation_id),
    index("idx_slack_publications_user_agent").on(t.user_id, t.agent_id),
    // NOTE: unlike linear/github, slack's tenant index has NO created_at DESC.
    index("idx_slack_publications_tenant").on(t.tenant_id),
    index("idx_slack_publications_slack_app_id").on(t.slack_app_id),
  ],
);

// ─── slack_webhook_events ─────────────────────────────────────────────────
// Slack webhook dedup + audit. delivery_id is Slack's event_id (or a
// synthetic Slash command id). Inline dispatch — no async queue columns.
export const slack_webhook_events = sqliteTable(
  "slack_webhook_events",
  {
    delivery_id: text("delivery_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    installation_id: text("installation_id").notNull(),
    publication_id: text("publication_id"),
    event_type: text("event_type").notNull(),
    received_at: integer("received_at").notNull(),
    session_id: text("session_id"),
    error: text("error"),
  },
  (t) => [
    index("idx_slack_webhook_events_received").on(
      sql`${t.received_at} DESC`,
    ),
    index("idx_slack_webhook_events_tenant").on(
      t.tenant_id,
      sql`${t.received_at} DESC`,
    ),
  ],
);

// ─── slack_setup_links ────────────────────────────────────────────────────
// Setup link tokens for non-admin handoff (publisher → workspace admin).
// Same shape as linear_setup_links.
export const slack_setup_links = sqliteTable(
  "slack_setup_links",
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
    index("idx_slack_setup_links_expires").on(t.expires_at),
    index("idx_slack_setup_links_tenant").on(t.tenant_id),
  ],
);

// ─── slack_thread_sessions ────────────────────────────────────────────────
// Channel/thread ↔ session mapping. scope_key encodes the granularity unit
// (channel id, thread ts, etc.). Composite PK. pending_scan_until and
// last_scan_at drive the lazy backfill scanner.
export const slack_thread_sessions = sqliteTable(
  "slack_thread_sessions",
  {
    publication_id: text("publication_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    scope_key: text("scope_key").notNull(),
    session_id: text("session_id").notNull(),
    status: text("status").notNull(),
    created_at: integer("created_at").notNull(),
    pending_scan_until: integer("pending_scan_until"),
    last_scan_at: integer("last_scan_at"),
    channel_name: text("channel_name"),
  },
  (t) => [
    primaryKey({ columns: [t.publication_id, t.scope_key] }),
    index("idx_slack_thread_sessions_active").on(t.publication_id, t.status),
    index("idx_slack_thread_sessions_tenant").on(t.tenant_id),
  ],
);
