// GitHub integration tables — Node-PG variant.
//
// Structurally identical to packages/db-schema/src/cf-integrations/github.ts.
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

export const github_apps = pgTable(
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
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_github_apps_app_id").on(t.app_id),
    index("idx_github_apps_tenant").on(t.tenant_id),
  ],
);

export const github_installations = pgTable(
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
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    revoked_at: bigint("revoked_at", { mode: "number" }),
    vault_id: text("vault_id"),
  },
  (t) => [
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
      t.created_at.desc(),
    ),
  ],
);

export const github_publications = pgTable(
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
    capabilities: text("capabilities").notNull(),
    session_granularity: text("session_granularity").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    unpublished_at: bigint("unpublished_at", { mode: "number" }),
    environment_id: text("environment_id"),
    app_oma_id: text("app_oma_id"),
    client_id: text("client_id"),
    client_secret_cipher: text("client_secret_cipher"),
    app_id: text("app_id"),
    app_slug: text("app_slug"),
    bot_login: text("bot_login"),
    webhook_secret_cipher: text("webhook_secret_cipher"),
    private_key_cipher: text("private_key_cipher"),
    vault_id: text("vault_id"),
    trigger_label: text("trigger_label"),
  },
  (t) => [
    index("idx_github_publications_installation").on(t.installation_id),
    index("idx_github_publications_user_agent").on(t.user_id, t.agent_id),
    index("idx_github_publications_tenant").on(
      t.tenant_id,
      t.created_at.desc(),
    ),
    index("idx_github_publications_app_oma_id").on(t.app_oma_id),
    index("idx_github_publications_app_id").on(t.app_id),
  ],
);

export const github_webhook_events = pgTable(
  "github_webhook_events",
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
    index("idx_github_webhook_events_received").on(t.received_at.desc()),
    index("idx_github_webhook_events_tenant").on(
      t.tenant_id,
      t.received_at.desc(),
    ),
  ],
);

export const github_issue_sessions = pgTable(
  "github_issue_sessions",
  {
    publication_id: text("publication_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    issue_id: text("issue_id").notNull(),
    session_id: text("session_id").notNull(),
    status: text("status").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.publication_id, t.issue_id] }),
    index("idx_github_issue_sessions_active").on(t.publication_id, t.status),
    index("idx_github_issue_sessions_tenant").on(t.tenant_id),
  ],
);
