CREATE TABLE `managed_session_initial_events` (
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`document` text NOT NULL,
	PRIMARY KEY(`session_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `managed_session_memory_stores` (
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`memory_store_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `memory_store_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_session_memory_stores_workspace_store` ON `managed_session_memory_stores` (`workspace_id`,`memory_store_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `managed_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version` integer NOT NULL,
	`environment_id` text NOT NULL,
	`deployment_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_managed_sessions_workspace_created_id` ON `managed_sessions` (`workspace_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_managed_sessions_workspace_agent` ON `managed_sessions` (`workspace_id`,`agent_id`,`agent_version`);