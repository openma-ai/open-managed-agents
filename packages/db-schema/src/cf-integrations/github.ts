// GitHub integration tables (CF INTEGRATIONS_DB / D1 SQLite).
//
// Source of truth: apps/main/migrations-integrations/0001_consolidated.sql
// (the squashed baseline; pre-squash sources in _archive/0001+0003+0005+0006).

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── github_apps ──────────────────────────────────────────────────────────
// Per-publication GitHub App credentials. webhook_secret + private_key are
// AES-GCM encrypted; client_id / app_id / app_slug / bot_login are plaintext
// (public-ish identifiers).
export const github_apps = sqliteTable(
  "github_apps",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").unique(),
    app_id: text("app_id").notNull(),
    app_slug: text("app_slug").notNull(),
    bot_login: text("bot_login").notNull(),
    client_id: text("client_id"),
    client_secret_cipher: text("client_secret_cipher"),
    webhook_secret_cipher: text("webhook_secret_cipher").notNull(),
    private_key_cipher: text("private_key_cipher").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_github_apps_app_id").on(t.app_id),
    index("idx_github_apps_tenant").on(t.tenant_id),
  ],
);

// ─── github_installations ─────────────────────────────────────────────────
// Workspace installations for GitHub. Mirrors the linear/slack shape.
export const github_installations = sqliteTable(
  "github_installations",
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
    // Active-install UNIQUE — see linear.ts for the COALESCE caveat.
    uniqueIndex("idx_github_installations_active")
      .on(
        t.provider_id,
        t.workspace_id,
        t.install_kind,
        sql`COALESCE(${t.app_id}, '')`,
      )
      .where(sql`${t.revoked_at} IS NULL`),
    index("idx_github_installations_user").on(
      t.user_id,
      t.provider_id,
      t.revoked_at,
    ),
    index("idx_github_installations_tenant").on(
      t.tenant_id,
      sql`${t.created_at} DESC`,
    ),
  ],
);

// ─── github_publications ──────────────────────────────────────────────────
// Agent ↔ repo bindings. Same publication-first shape as linear/slack:
// app_oma_id pre-minted at shell create so the webhook URL is stable from
// minute one. trigger_label (0006) is the new primary engagement path.
export const github_publications = sqliteTable(
  "github_publications",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id").notNull(),
    installation_id: text("installation_id")
      .notNull()
      .references(() => github_installations.id),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    persona_name: text("persona_name").notNull(),
    persona_avatar_url: text("persona_avatar_url"),
    capabilities: text("capabilities").notNull(), // JSON
    session_granularity: text("session_granularity").notNull(),
    created_at: integer("created_at").notNull(),
    unpublished_at: integer("unpublished_at"),
    environment_id: text("environment_id"),
    // 0003_github_publication_first.sql: pre-OAuth credential staging
    app_oma_id: text("app_oma_id"),
    client_id: text("client_id"),
    client_secret_cipher: text("client_secret_cipher"),
    app_id: text("app_id"),
    app_slug: text("app_slug"),
    bot_login: text("bot_login"),
    webhook_secret_cipher: text("webhook_secret_cipher"),
    private_key_cipher: text("private_key_cipher"),
    vault_id: text("vault_id"),
    // 0006_github_trigger_label.sql
    trigger_label: text("trigger_label"),
  },
  (t) => [
    index("idx_github_publications_installation").on(t.installation_id),
    index("idx_github_publications_user_agent").on(t.user_id, t.agent_id),
    index("idx_github_publications_tenant").on(
      t.tenant_id,
      sql`${t.created_at} DESC`,
    ),
    // 0003: webhook handler primary path is by app_oma_id; ops "find pub
    // for app 7654321" by GitHub's numeric app_id.
    index("idx_github_publications_app_oma_id").on(t.app_oma_id),
    index("idx_github_publications_app_id").on(t.app_id),
  ],
);

// ─── github_webhook_events ────────────────────────────────────────────────
// GitHub webhook dedup + audit. delivery_id = `x-github-delivery` UUID.
// Inline dispatch (no async queue), so no event_kind / payload_json /
// processed_at columns — same shape as slack_webhook_events.
export const github_webhook_events = sqliteTable(
  "github_webhook_events",
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
    index("idx_github_webhook_events_received").on(
      sql`${t.received_at} DESC`,
    ),
    index("idx_github_webhook_events_tenant").on(
      t.tenant_id,
      sql`${t.received_at} DESC`,
    ),
  ],
);

// ─── github_issue_sessions ────────────────────────────────────────────────
// Per-issue session bookkeeping (split out of linear_issue_sessions in 0005).
// issue_id format is "<owner/repo>#<number>". Composite PK.
export const github_issue_sessions = sqliteTable(
  "github_issue_sessions",
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
    index("idx_github_issue_sessions_active").on(t.publication_id, t.status),
    index("idx_github_issue_sessions_tenant").on(t.tenant_id),
  ],
);
