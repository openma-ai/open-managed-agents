CREATE TABLE "managed_agent_versions" (
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"version" bigint NOT NULL,
	"document" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "managed_agent_versions_agent_id_version_pk" PRIMARY KEY("agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "managed_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"document" text NOT NULL,
	"version" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "feishu_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text,
	"app_id" text NOT NULL,
	"app_secret_cipher" text NOT NULL,
	"verification_token_cipher" text NOT NULL,
	"encrypt_key_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "feishu_apps_publication_id_unique" UNIQUE("publication_id")
);
--> statement-breakpoint
CREATE TABLE "feishu_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"install_kind" text NOT NULL,
	"app_id" text,
	"tenant_access_token_cipher" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"scopes" text NOT NULL,
	"bot_open_id" text,
	"vault_id" text,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "feishu_publications" (
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
	"created_at" bigint NOT NULL,
	"unpublished_at" bigint,
	"app_id" text,
	"app_secret_cipher" text,
	"verification_token_cipher" text,
	"encrypt_key_cipher" text
);
--> statement-breakpoint
CREATE TABLE "feishu_setup_links" (
	"token" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"used_by_email" text
);
--> statement-breakpoint
CREATE TABLE "feishu_thread_sessions" (
	"publication_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"chat_name" text,
	CONSTRAINT "feishu_thread_sessions_publication_id_scope_key_pk" PRIMARY KEY("publication_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "feishu_webhook_events" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"publication_id" text,
	"event_type" text NOT NULL,
	"received_at" bigint NOT NULL,
	"session_id" text,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "idx_managed_agent_versions_workspace_agent" ON "managed_agent_versions" USING btree ("workspace_id","agent_id","version");--> statement-breakpoint
CREATE INDEX "idx_managed_agents_workspace_created_id" ON "managed_agents" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_feishu_apps_tenant" ON "feishu_apps" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_installations_active" ON "feishu_installations" USING btree ("provider_id","workspace_id","install_kind",COALESCE("app_id", '')) WHERE "feishu_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_feishu_installations_user" ON "feishu_installations" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_installations_tenant" ON "feishu_installations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_publications_installation" ON "feishu_publications" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_publications_user_agent" ON "feishu_publications" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_publications_tenant" ON "feishu_publications" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_publications_app_id" ON "feishu_publications" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_setup_links_expires" ON "feishu_setup_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_feishu_setup_links_tenant" ON "feishu_setup_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_thread_sessions_active" ON "feishu_thread_sessions" USING btree ("publication_id","status");--> statement-breakpoint
CREATE INDEX "idx_feishu_thread_sessions_tenant" ON "feishu_thread_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_webhook_events_received" ON "feishu_webhook_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_feishu_webhook_events_tenant" ON "feishu_webhook_events" USING btree ("tenant_id","received_at" DESC NULLS LAST);