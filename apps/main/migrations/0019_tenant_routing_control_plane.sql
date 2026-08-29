-- Single-D1 deployments bind ROUTER_DB and AUTH_DB to the same database.
-- Keep the routing control-plane schema in the main migration stream so a
-- fresh self-host and an upgraded installation both support tenant signup.
-- Multi-shard deployments continue to use migrations-router for ROUTER_DB;
-- these idempotent tables in an auth shard are intentionally harmless.

CREATE TABLE IF NOT EXISTS "memory_store_tenant" (
  "store_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_store_tenant_tenant"
  ON "memory_store_tenant" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shard_pool" (
  "binding_name" text PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "tenant_count" integer DEFAULT 0 NOT NULL,
  "size_bytes" integer,
  "observed_at" integer,
  "notes" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shard_pool_status"
  ON "shard_pool" ("status", "tenant_count");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_shard" (
  "tenant_id" text PRIMARY KEY NOT NULL,
  "binding_name" text NOT NULL,
  "created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tenant_shard_binding"
  ON "tenant_shard" ("binding_name");
