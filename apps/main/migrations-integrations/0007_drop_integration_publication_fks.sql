-- Publication-first setup persists a publication before an installation
-- exists. These are asynchronous application-level references, not database
-- parent/child relations, so remove the three publication FKs consistently.
PRAGMA defer_foreign_keys = on;

CREATE TABLE "__new_linear_publications" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "persona_name" text NOT NULL,
  "persona_avatar_url" text,
  "capabilities" text NOT NULL,
  "session_granularity" text NOT NULL,
  "created_at" integer NOT NULL,
  "unpublished_at" integer,
  "environment_id" text,
  "client_id" text,
  "client_secret_cipher" text,
  "webhook_secret_cipher" text,
  "signing_secret_cipher" text,
  "vault_id" text
);
--> statement-breakpoint
INSERT INTO "__new_linear_publications" SELECT * FROM "linear_publications";
--> statement-breakpoint
DROP TABLE "linear_publications";
--> statement-breakpoint
ALTER TABLE "__new_linear_publications" RENAME TO "linear_publications";
--> statement-breakpoint
CREATE INDEX "idx_linear_publications_installation" ON "linear_publications" ("installation_id");
--> statement-breakpoint
CREATE INDEX "idx_linear_publications_user_agent" ON "linear_publications" ("user_id", "agent_id");
--> statement-breakpoint
CREATE INDEX "idx_linear_publications_tenant" ON "linear_publications" ("tenant_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE "__new_github_publications" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "persona_name" text NOT NULL,
  "persona_avatar_url" text,
  "capabilities" text NOT NULL,
  "session_granularity" text NOT NULL,
  "created_at" integer NOT NULL,
  "unpublished_at" integer,
  "environment_id" text,
  "app_oma_id" text,
  "client_id" text,
  "client_secret_cipher" text,
  "app_id" text,
  "app_slug" text,
  "bot_login" text,
  "webhook_secret_cipher" text,
  "private_key_cipher" text,
  "vault_id" text,
  "trigger_label" text
);
--> statement-breakpoint
INSERT INTO "__new_github_publications" SELECT * FROM "github_publications";
--> statement-breakpoint
DROP TABLE "github_publications";
--> statement-breakpoint
ALTER TABLE "__new_github_publications" RENAME TO "github_publications";
--> statement-breakpoint
CREATE INDEX "idx_github_publications_installation" ON "github_publications" ("installation_id");
--> statement-breakpoint
CREATE INDEX "idx_github_publications_user_agent" ON "github_publications" ("user_id", "agent_id");
--> statement-breakpoint
CREATE INDEX "idx_github_publications_tenant" ON "github_publications" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_github_publications_app_oma_id" ON "github_publications" ("app_oma_id");
--> statement-breakpoint
CREATE INDEX "idx_github_publications_app_id" ON "github_publications" ("app_id");
--> statement-breakpoint

CREATE TABLE "__new_slack_publications" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "user_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "environment_id" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "persona_name" text NOT NULL,
  "persona_avatar_url" text,
  "capabilities" text NOT NULL,
  "session_granularity" text NOT NULL,
  "created_at" integer NOT NULL,
  "unpublished_at" integer,
  "client_id" text,
  "client_secret_cipher" text,
  "signing_secret_cipher" text,
  "slack_app_id" text
);
--> statement-breakpoint
INSERT INTO "__new_slack_publications" SELECT * FROM "slack_publications";
--> statement-breakpoint
DROP TABLE "slack_publications";
--> statement-breakpoint
ALTER TABLE "__new_slack_publications" RENAME TO "slack_publications";
--> statement-breakpoint
CREATE INDEX "idx_slack_publications_installation" ON "slack_publications" ("installation_id");
--> statement-breakpoint
CREATE INDEX "idx_slack_publications_user_agent" ON "slack_publications" ("user_id", "agent_id");
--> statement-breakpoint
CREATE INDEX "idx_slack_publications_tenant" ON "slack_publications" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "idx_slack_publications_slack_app_id" ON "slack_publications" ("slack_app_id");

PRAGMA defer_foreign_keys = off;
