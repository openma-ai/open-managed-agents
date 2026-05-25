// Linear integration tables — Node-PG variant.
//
// Structurally identical to packages/db-schema/src/cf-integrations/linear.ts
// (SQLite). PG-typed columns: BIGINT for ms-epoch timestamps and 0/1 flags.
// Cipher columns and JSON blobs stay TEXT (opaque to the DB).
//
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

// See cf-integrations/linear.ts for behavioral notes.
export const linear_apps = pgTable(
  "linear_apps",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").unique(),
    client_id: text("client_id").notNull(),
    client_secret_cipher: text("client_secret_cipher").notNull(),
    webhook_secret_cipher: text("webhook_secret_cipher").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_linear_apps_tenant").on(t.tenant_id)],
);

export const linear_installations = pgTable(
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
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    revoked_at: bigint("revoked_at", { mode: "number" }),
    vault_id: text("vault_id"),
  },
  (t) => [
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
      t.created_at.desc(),
    ),
  ],
);

export const linear_publications = pgTable(
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
    capabilities: text("capabilities").notNull(),
    session_granularity: text("session_granularity").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    unpublished_at: bigint("unpublished_at", { mode: "number" }),
    environment_id: text("environment_id"),
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
      t.created_at.desc(),
    ),
  ],
);

export const linear_events = pgTable(
  "linear_events",
  {
    delivery_id: text("delivery_id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    installation_id: text("installation_id").notNull(),
    publication_id: text("publication_id"),
    event_type: text("event_type").notNull(),
    received_at: bigint("received_at", { mode: "number" }).notNull(),
    session_id: text("session_id"),
    error: text("error"),
    event_kind: text("event_kind"),
    payload_json: text("payload_json"),
    processed_at: bigint("processed_at", { mode: "number" }),
    processed_session_id: text("processed_session_id"),
  },
  (t) => [
    index("idx_linear_events_received").on(t.received_at.desc()),
    index("idx_linear_events_tenant").on(t.tenant_id, t.received_at.desc()),
    index("idx_linear_events_unprocessed")
      .on(t.received_at)
      .where(
        sql`${t.payload_json} IS NOT NULL AND ${t.processed_at} IS NULL`,
      ),
    index("idx_linear_events_publication").on(
      t.publication_id,
      t.received_at.desc(),
    ),
  ],
);

export const linear_setup_links = pgTable(
  "linear_setup_links",
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
    index("idx_linear_setup_links_expires").on(t.expires_at),
    index("idx_linear_setup_links_tenant").on(t.tenant_id),
  ],
);

export const linear_issue_sessions = pgTable(
  "linear_issue_sessions",
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
    index("idx_linear_issue_sessions_active").on(t.publication_id, t.status),
    index("idx_linear_issue_sessions_tenant").on(t.tenant_id),
  ],
);

export const linear_authored_comments = pgTable(
  "linear_authored_comments",
  {
    comment_id: text("comment_id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    oma_session_id: text("oma_session_id").notNull(),
    issue_id: text("issue_id").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_linear_authored_comments_session").on(t.oma_session_id),
    index("idx_linear_authored_comments_tenant").on(t.tenant_id),
  ],
);

export const linear_dispatch_rules = pgTable(
  "linear_dispatch_rules",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    publication_id: text("publication_id").notNull(),
    name: text("name").notNull(),
    enabled: bigint("enabled", { mode: "number" }).notNull().default(1),
    filter_label: text("filter_label"),
    filter_states: text("filter_states"),
    filter_project_id: text("filter_project_id"),
    max_concurrent: bigint("max_concurrent", { mode: "number" })
      .notNull()
      .default(5),
    poll_interval_seconds: bigint("poll_interval_seconds", { mode: "number" })
      .notNull()
      .default(600),
    last_polled_at: bigint("last_polled_at", { mode: "number" }),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_linear_dispatch_rules_sweep").on(t.enabled, t.last_polled_at),
    index("idx_linear_dispatch_rules_publication").on(t.publication_id),
    index("idx_linear_dispatch_rules_tenant").on(
      t.tenant_id,
      t.created_at.desc(),
    ),
  ],
);
