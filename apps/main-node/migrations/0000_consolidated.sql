CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "membership_user_id_tenant_id_pk" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"tenantId" text,
	"role" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"agent_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"version" bigint NOT NULL,
	"snapshot" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "agent_versions_agent_id_version_pk" PRIMARY KEY("agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"config" text NOT NULL,
	"version" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "session_memory_stores" (
	"session_id" text NOT NULL,
	"store_id" text NOT NULL,
	"access" text DEFAULT 'read_write' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "session_memory_stores_session_id_store_id_pk" PRIMARY KEY("session_id","store_id")
);
--> statement-breakpoint
CREATE TABLE "session_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"memory_store_id" text,
	"mount_path" text,
	"access" text,
	"instructions" text,
	"url" text,
	"checkout_type" text,
	"checkout_name" text,
	"checkout_sha" text,
	"name" text,
	"value" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text,
	"environment_id" text,
	"status" text NOT NULL,
	"title" text,
	"vault_ids" text,
	"agent_snapshot" text,
	"environment_snapshot" text,
	"metadata" text,
	"turn_id" text,
	"turn_started_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"archived_at" bigint,
	"terminated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"path" text NOT NULL,
	"content_sha256" text NOT NULL,
	"etag" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_blob_poller_lease" (
	"store_id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_seen_ms" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_stores" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "memory_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"store_id" text NOT NULL,
	"operation" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"redacted" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vault_id" text NOT NULL,
	"display_name" text NOT NULL,
	"auth_type" text NOT NULL,
	"mcp_server_url" text,
	"provider" text,
	"auth" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "model_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text,
	"custom_headers" text,
	"api_key_cipher" text NOT NULL,
	"api_key_preview" text NOT NULL,
	"is_default" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"sandbox_worker_name" text,
	"build_error" text,
	"config" text NOT NULL,
	"metadata" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"archived_at" bigint,
	"image_strategy" text,
	"image_handle" text
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" text,
	"scope" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"downloadable" bigint DEFAULT 0 NOT NULL,
	"r2_key" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"blob_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_runtime_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"state" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "runtime_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"runtime_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"revoked_at" bigint,
	"last_used_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "runtime_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "runtimes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_tenant_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"agents_json" text DEFAULT '[]' NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_heartbeat" bigint,
	"created_at" bigint NOT NULL,
	"local_skills_json" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"suite" text,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"results" text,
	"score" double precision,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text,
	"kind" text NOT NULL,
	"value" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"billed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "kv_entries" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "kv_entries_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "memory_store_tenant" (
	"store_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shard_pool" (
	"binding_name" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"tenant_count" bigint DEFAULT 0 NOT NULL,
	"size_bytes" bigint,
	"observed_at" bigint,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "tenant_shard" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"binding_name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text,
	"client_id" text NOT NULL,
	"client_secret_cipher" text NOT NULL,
	"webhook_secret_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "linear_apps_publication_id_unique" UNIQUE("publication_id")
);
--> statement-breakpoint
CREATE TABLE "linear_authored_comments" (
	"comment_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"oma_session_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_dispatch_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" bigint DEFAULT 1 NOT NULL,
	"filter_label" text,
	"filter_states" text,
	"filter_project_id" text,
	"max_concurrent" bigint DEFAULT 5 NOT NULL,
	"poll_interval_seconds" bigint DEFAULT 600 NOT NULL,
	"last_polled_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_events" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"publication_id" text,
	"event_type" text NOT NULL,
	"received_at" bigint NOT NULL,
	"session_id" text,
	"error" text,
	"event_kind" text,
	"payload_json" text,
	"processed_at" bigint,
	"processed_session_id" text
);
--> statement-breakpoint
CREATE TABLE "linear_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"install_kind" text NOT NULL,
	"app_id" text,
	"access_token_cipher" text NOT NULL,
	"refresh_token_cipher" text,
	"scopes" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint,
	"vault_id" text
);
--> statement-breakpoint
CREATE TABLE "linear_issue_sessions" (
	"publication_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "linear_issue_sessions_publication_id_issue_id_pk" PRIMARY KEY("publication_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "linear_publications" (
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
	"created_at" bigint NOT NULL,
	"unpublished_at" bigint,
	"environment_id" text,
	"client_id" text,
	"client_secret_cipher" text,
	"webhook_secret_cipher" text,
	"signing_secret_cipher" text,
	"vault_id" text
);
--> statement-breakpoint
CREATE TABLE "linear_setup_links" (
	"token" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"used_by_email" text
);
--> statement-breakpoint
CREATE TABLE "github_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text,
	"app_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"bot_login" text NOT NULL,
	"client_id" text,
	"client_secret_cipher" text,
	"webhook_secret_cipher" text NOT NULL,
	"private_key_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "github_apps_publication_id_unique" UNIQUE("publication_id")
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"install_kind" text NOT NULL,
	"app_id" text,
	"access_token_cipher" text NOT NULL,
	"refresh_token_cipher" text,
	"scopes" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint,
	"vault_id" text
);
--> statement-breakpoint
CREATE TABLE "github_issue_sessions" (
	"publication_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "github_issue_sessions_publication_id_issue_id_pk" PRIMARY KEY("publication_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "github_publications" (
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
	"created_at" bigint NOT NULL,
	"unpublished_at" bigint,
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
CREATE TABLE "github_webhook_events" (
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
CREATE TABLE "slack_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text,
	"client_id" text NOT NULL,
	"client_secret_cipher" text NOT NULL,
	"signing_secret_cipher" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "slack_apps_publication_id_unique" UNIQUE("publication_id")
);
--> statement-breakpoint
CREATE TABLE "slack_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"install_kind" text NOT NULL,
	"app_id" text,
	"access_token_cipher" text NOT NULL,
	"user_token_cipher" text,
	"scopes" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"vault_id" text,
	"bot_vault_id" text,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "slack_publications" (
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
	"client_id" text,
	"client_secret_cipher" text,
	"signing_secret_cipher" text,
	"slack_app_id" text
);
--> statement-breakpoint
CREATE TABLE "slack_setup_links" (
	"token" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"used_by_email" text
);
--> statement-breakpoint
CREATE TABLE "slack_thread_sessions" (
	"publication_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"pending_scan_until" bigint,
	"last_scan_at" bigint,
	"channel_name" text,
	CONSTRAINT "slack_thread_sessions_publication_id_scope_key_pk" PRIMARY KEY("publication_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "slack_webhook_events" (
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
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_publications" ADD CONSTRAINT "linear_publications_installation_id_linear_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."linear_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_publications" ADD CONSTRAINT "github_publications_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_publications" ADD CONSTRAINT "slack_publications_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_userId" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_membership_user" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_session_userId" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_verification_identifier" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "idx_agents_tenant" ON "agents" USING btree ("tenant_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_session_resources_session" ON "session_resources" USING btree ("session_id","type");--> statement-breakpoint
CREATE INDEX "idx_sessions_status" ON "sessions" USING btree ("status","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_tenant_archived" ON "sessions" USING btree ("tenant_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_running" ON "sessions" USING btree ("tenant_id","id") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_sessions_terminated" ON "sessions" USING btree ("tenant_id","terminated_at") WHERE "terminated_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memories_store_path" ON "memories" USING btree ("store_id","path");--> statement-breakpoint
CREATE INDEX "idx_memory_stores_tenant" ON "memory_stores" USING btree ("tenant_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_memory_versions_store" ON "memory_versions" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_versions_memory" ON "memory_versions" USING btree ("memory_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_credentials_vault" ON "credentials" USING btree ("tenant_id","vault_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credentials_mcp_url_active" ON "credentials" USING btree ("tenant_id","vault_id","mcp_server_url") WHERE "mcp_server_url" IS NOT NULL AND "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_credentials_provider" ON "credentials" USING btree ("tenant_id","vault_id","provider") WHERE "provider" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_vaults_tenant" ON "vaults" USING btree ("tenant_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_cards_model_id" ON "model_cards" USING btree ("tenant_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_cards_default" ON "model_cards" USING btree ("tenant_id") WHERE "is_default" = 1;--> statement-breakpoint
CREATE INDEX "idx_model_cards_tenant" ON "model_cards" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_environments_tenant" ON "environments" USING btree ("tenant_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_files_tenant_created" ON "files" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_files_tenant_session_created" ON "files" USING btree ("tenant_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_files_session" ON "files" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_backups_session" ON "workspace_backups" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workspace_backups_expires" ON "workspace_backups" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_connect_runtime_codes_expires" ON "connect_runtime_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_tokens_runtime" ON "runtime_tokens" USING btree ("runtime_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_runtimes_user_machine" ON "runtimes" USING btree ("owner_user_id","machine_id");--> statement-breakpoint
CREATE INDEX "idx_runtimes_tenant" ON "runtimes" USING btree ("owner_tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_eval_runs_tenant_started" ON "eval_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_eval_runs_tenant_agent_started" ON "eval_runs" USING btree ("tenant_id","agent_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_eval_runs_tenant_environment_started" ON "eval_runs" USING btree ("tenant_id","environment_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_eval_runs_status_active" ON "eval_runs" USING btree ("status","started_at") WHERE "status" = 'pending' OR "status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_usage_events_unbilled" ON "usage_events" USING btree ("tenant_id","id") WHERE "billed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_events_session" ON "usage_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_tenant" ON "api_keys" USING btree ("tenant_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_kv_entries_expires" ON "kv_entries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_memory_store_tenant_tenant" ON "memory_store_tenant" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_shard_pool_status" ON "shard_pool" USING btree ("status","tenant_count");--> statement-breakpoint
CREATE INDEX "idx_tenant_shard_binding" ON "tenant_shard" USING btree ("binding_name");--> statement-breakpoint
CREATE INDEX "idx_linear_apps_tenant" ON "linear_apps" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_linear_authored_comments_session" ON "linear_authored_comments" USING btree ("oma_session_id");--> statement-breakpoint
CREATE INDEX "idx_linear_authored_comments_tenant" ON "linear_authored_comments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_linear_dispatch_rules_sweep" ON "linear_dispatch_rules" USING btree ("enabled","last_polled_at");--> statement-breakpoint
CREATE INDEX "idx_linear_dispatch_rules_publication" ON "linear_dispatch_rules" USING btree ("publication_id");--> statement-breakpoint
CREATE INDEX "idx_linear_dispatch_rules_tenant" ON "linear_dispatch_rules" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_linear_events_received" ON "linear_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_linear_events_tenant" ON "linear_events" USING btree ("tenant_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_linear_events_unprocessed" ON "linear_events" USING btree ("received_at") WHERE "linear_events"."payload_json" IS NOT NULL AND "linear_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_linear_events_publication" ON "linear_events" USING btree ("publication_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_linear_installations_active" ON "linear_installations" USING btree ("provider_id","workspace_id","install_kind",COALESCE("app_id", '')) WHERE "linear_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_linear_installations_user" ON "linear_installations" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_linear_installations_tenant" ON "linear_installations" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_linear_issue_sessions_active" ON "linear_issue_sessions" USING btree ("publication_id","status");--> statement-breakpoint
CREATE INDEX "idx_linear_issue_sessions_tenant" ON "linear_issue_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_linear_publications_installation" ON "linear_publications" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_linear_publications_user_agent" ON "linear_publications" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_linear_publications_tenant" ON "linear_publications" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_linear_setup_links_expires" ON "linear_setup_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_linear_setup_links_tenant" ON "linear_setup_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_github_apps_app_id" ON "github_apps" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_github_apps_tenant" ON "github_apps" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_installations_active" ON "github_installations" USING btree ("provider_id","workspace_id","install_kind",COALESCE("app_id", '')) WHERE "github_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_github_installations_user" ON "github_installations" USING btree ("user_id","provider_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_github_installations_tenant" ON "github_installations" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_github_issue_sessions_active" ON "github_issue_sessions" USING btree ("publication_id","status");--> statement-breakpoint
CREATE INDEX "idx_github_issue_sessions_tenant" ON "github_issue_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_github_publications_installation" ON "github_publications" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_github_publications_user_agent" ON "github_publications" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_github_publications_tenant" ON "github_publications" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_github_publications_app_oma_id" ON "github_publications" USING btree ("app_oma_id");--> statement-breakpoint
CREATE INDEX "idx_github_publications_app_id" ON "github_publications" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_github_webhook_events_received" ON "github_webhook_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_github_webhook_events_tenant" ON "github_webhook_events" USING btree ("tenant_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_slack_apps_tenant" ON "slack_apps" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_installations_active" ON "slack_installations" USING btree ("provider_id","workspace_id","install_kind",COALESCE("app_id", '')) WHERE "slack_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_slack_installations_user" ON "slack_installations" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_slack_installations_tenant" ON "slack_installations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_slack_publications_installation" ON "slack_publications" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_slack_publications_user_agent" ON "slack_publications" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_slack_publications_tenant" ON "slack_publications" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_slack_publications_slack_app_id" ON "slack_publications" USING btree ("slack_app_id");--> statement-breakpoint
CREATE INDEX "idx_slack_setup_links_expires" ON "slack_setup_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_slack_setup_links_tenant" ON "slack_setup_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_slack_thread_sessions_active" ON "slack_thread_sessions" USING btree ("publication_id","status");--> statement-breakpoint
CREATE INDEX "idx_slack_thread_sessions_tenant" ON "slack_thread_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_slack_webhook_events_received" ON "slack_webhook_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_slack_webhook_events_tenant" ON "slack_webhook_events" USING btree ("tenant_id","received_at" DESC NULLS LAST);