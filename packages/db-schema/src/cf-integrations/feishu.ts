// Feishu integration tables (CF INTEGRATIONS_DB / D1 SQLite).
//
// Source of truth: apps/main/migrations-integrations/0007_feishu_publication_first.sql
//
// Feishu differs from Slack in three load-bearing ways:
//   1. No OAuth — credentials are App ID + App Secret + Verification Token +
//      Encrypt Key (the latter two are Feishu's URL-verification signing
//      material). Bots live on the App; the install row carries the tenant
//      access token instead.
//   2. Inbound events arrive over WebSocket long-poll (not HTTP webhooks).
//      The route layer still mounts an HTTP handler for the legacy URL
//      verification handshake; the production ingest is the WsFeishuRunner
//      started in apps/main-node.
//   3. session_granularity is per_chat (group) or per_chat_user (DM) —
//      Feishu has no Slack-style threads. scope_key encodes that choice.

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── feishu_apps ────────────────────────────────────────────────────────
// Per-publication Feishu App credentials. Each row pairs with at most one
// feishu_publications row. Publication-first install writes creds directly
// onto feishu_publications; this legacy table exists for parity with Slack.
export const feishu_apps = sqliteTable(
  "feishu_apps",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").unique(),
    app_id: text("app_id").notNull(),
    app_secret_cipher: text("app_secret_cipher").notNull(),
    verification_token_cipher: text("verification_token_cipher").notNull(),
    encrypt_key_cipher: text("encrypt_key_cipher").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [index("idx_feishu_apps_tenant").on(t.tenant_id)],
);

// ─── feishu_installations ───────────────────────────────────────────────
// Workspace (tenant) installations for Feishu. tenant_access_token_cipher
// stores the cached tenant_access_token (Feishu's per-tenant bearer, ~2h TTL);
// the runner refreshes it on 401. workspace_id mirrors Slack's shape for
// downstream tooling that walks installations uniformly across providers.
export const feishu_installations = sqliteTable(
  "feishu_installations",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    provider_id: text("provider_id").notNull(),
    workspace_id: text("workspace_id").notNull(),
    workspace_name: text("workspace_name").notNull(),
    install_kind: text("install_kind").notNull(),
    app_id: text("app_id"),
    tenant_access_token_cipher: text("tenant_access_token_cipher").notNull(),
    expires_at: integer("expires_at").notNull(),
    scopes: text("scopes").notNull(),
    bot_open_id: text("bot_open_id"),
    vault_id: text("vault_id"),
    created_at: integer("created_at").notNull(),
    revoked_at: integer("revoked_at"),
  },
  (t) => [
    // Active-install UNIQUE — same pattern as slack/linear.
    uniqueIndex("idx_feishu_installations_active")
      .on(
        t.provider_id,
        t.workspace_id,
        t.install_kind,
        sql`COALESCE(${t.app_id}, '')`,
      )
      .where(sql`${t.revoked_at} IS NULL`),
    index("idx_feishu_installations_user").on(t.user_id, t.provider_id),
    index("idx_feishu_installations_tenant").on(t.tenant_id),
  ],
);

// ─── feishu_publications ────────────────────────────────────────────────
// Agent ↔ workspace bindings. environment_id is NOT NULL here (same as
// Slack). Publication-first columns: app_id, app_secret_cipher,
// verification_token_cipher, encrypt_key_cipher (all nullable until set).
export const feishu_publications = sqliteTable(
  "feishu_publications",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id").notNull(),
    installation_id: text("installation_id").notNull(),
    environment_id: text("environment_id").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    persona_name: text("persona_name").notNull(),
    persona_avatar_url: text("persona_avatar_url"),
    capabilities: text("capabilities").notNull(), // JSON
    session_granularity: text("session_granularity").notNull(),
    created_at: integer("created_at").notNull(),
    unpublished_at: integer("unpublished_at"),
    // 0007_feishu_publication_first.sql: pre-install credential staging
    app_id: text("app_id"),
    app_secret_cipher: text("app_secret_cipher"),
    verification_token_cipher: text("verification_token_cipher"),
    encrypt_key_cipher: text("encrypt_key_cipher"),
  },
  (t) => [
    index("idx_feishu_publications_installation").on(t.installation_id),
    index("idx_feishu_publications_user_agent").on(t.user_id, t.agent_id),
    index("idx_feishu_publications_tenant").on(t.tenant_id),
    index("idx_feishu_publications_app_id").on(t.app_id),
  ],
);

// ─── feishu_webhook_events ──────────────────────────────────────────────
// HTTP webhook dedup + audit. delivery_id is Feishu's message_id for the
// legacy URL-verification / HTTP callback path. The WebSocket runner uses
// feishu_message_events (in node-sqlite/feishu-ops.ts) for the WS ingest
// dedup path — this table is for HTTP events only.
export const feishu_webhook_events = sqliteTable(
  "feishu_webhook_events",
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
    index("idx_feishu_webhook_events_received").on(
      sql`${t.received_at} DESC`,
    ),
    index("idx_feishu_webhook_events_tenant").on(
      t.tenant_id,
      sql`${t.received_at} DESC`,
    ),
  ],
);

// ─── feishu_setup_links ─────────────────────────────────────────────────
// Setup link tokens for non-admin handoff (publisher → workspace admin).
// Same shape as slack_setup_links.
export const feishu_setup_links = sqliteTable(
  "feishu_setup_links",
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
    index("idx_feishu_setup_links_expires").on(t.expires_at),
    index("idx_feishu_setup_links_tenant").on(t.tenant_id),
  ],
);

// ─── feishu_thread_sessions ─────────────────────────────────────────────
// Chat (group or DM) ↔ session mapping. scope_key encodes granularity:
//   per_chat       → `chat:${chat_id}`
//   per_chat_user  → `chat:${chat_id}:user:${open_id}`
//   per_event      → `event:${message_id}`
// Composite PK. Feishu has no Slack-style pending_scan_until / last_scan_at —
// the WS runner delivers every message; debouncing happens at the agent
// harness layer.
export const feishu_thread_sessions = sqliteTable(
  "feishu_thread_sessions",
  {
    publication_id: text("publication_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    scope_key: text("scope_key").notNull(),
    session_id: text("session_id").notNull(),
    status: text("status").notNull(),
    created_at: integer("created_at").notNull(),
    chat_name: text("chat_name"),
  },
  (t) => [
    primaryKey({ columns: [t.publication_id, t.scope_key] }),
    index("idx_feishu_thread_sessions_active").on(t.publication_id, t.status),
    index("idx_feishu_thread_sessions_tenant").on(t.tenant_id),
  ],
);
