// Slack integration tables — Node-PG variant.
//
// Structurally identical to packages/db-schema/src/cf-integrations/slack.ts.
// Source of truth: apps/main/migrations-integrations/0001_consolidated.sql.

import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const slack_apps = pgTable(
  "slack_apps",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").unique(),
    client_id: text("client_id").notNull(),
    client_secret_cipher: text("client_secret_cipher").notNull(),
    signing_secret_cipher: text("signing_secret_cipher").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_slack_apps_tenant").on(t.tenant_id)],
);

export const slack_installations = pgTable(
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
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    revoked_at: bigint("revoked_at", { mode: "number" }),
  },
  (t) => [
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

export const slack_publications = pgTable(
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
    capabilities: text("capabilities").notNull(),
    session_granularity: text("session_granularity").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    unpublished_at: bigint("unpublished_at", { mode: "number" }),
    client_id: text("client_id"),
    client_secret_cipher: text("client_secret_cipher"),
    signing_secret_cipher: text("signing_secret_cipher"),
    slack_app_id: text("slack_app_id"),
  },
  (t) => [
    index("idx_slack_publications_installation").on(t.installation_id),
    index("idx_slack_publications_user_agent").on(t.user_id, t.agent_id),
    index("idx_slack_publications_tenant").on(t.tenant_id),
    index("idx_slack_publications_slack_app_id").on(t.slack_app_id),
  ],
);

export const slack_webhook_events = pgTable(
  "slack_webhook_events",
  {
    delivery_id: text("delivery_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    installation_id: text("installation_id").notNull(),
    publication_id: text("publication_id"),
    event_type: text("event_type").notNull(),
    received_at: bigint("received_at", { mode: "number" }).notNull(),
    session_id: text("session_id"),
    error: text("error"),
  },
  (t) => [
    index("idx_slack_webhook_events_received").on(t.received_at.desc()),
    index("idx_slack_webhook_events_tenant").on(
      t.tenant_id,
      t.received_at.desc(),
    ),
  ],
);

export const slack_setup_links = pgTable(
  "slack_setup_links",
  {
    token: text("token").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").notNull(),
    created_by: text("created_by").notNull(),
    expires_at: bigint("expires_at", { mode: "number" }).notNull(),
    used_at: bigint("used_at", { mode: "number" }),
    used_by_email: text("used_by_email"),
  },
  (t) => [
    index("idx_slack_setup_links_expires").on(t.expires_at),
    index("idx_slack_setup_links_tenant").on(t.tenant_id),
  ],
);

export const slack_thread_sessions = pgTable(
  "slack_thread_sessions",
  {
    publication_id: text("publication_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    scope_key: text("scope_key").notNull(),
    session_id: text("session_id").notNull(),
    status: text("status").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    pending_scan_until: bigint("pending_scan_until", { mode: "number" }),
    last_scan_at: bigint("last_scan_at", { mode: "number" }),
    channel_name: text("channel_name"),
  },
  (t) => [
    primaryKey({ columns: [t.publication_id, t.scope_key] }),
    index("idx_slack_thread_sessions_active").on(t.publication_id, t.status),
    index("idx_slack_thread_sessions_tenant").on(t.tenant_id),
  ],
);
