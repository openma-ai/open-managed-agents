CREATE TABLE `memory_store_tenant` (
	`store_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memory_store_tenant_tenant` ON `memory_store_tenant` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `shard_pool` (
	`binding_name` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`tenant_count` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer,
	`observed_at` integer,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `idx_shard_pool_status` ON `shard_pool` (`status`,`tenant_count`);--> statement-breakpoint
CREATE TABLE `tenant_shard` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`binding_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tenant_shard_binding` ON `tenant_shard` (`binding_name`);