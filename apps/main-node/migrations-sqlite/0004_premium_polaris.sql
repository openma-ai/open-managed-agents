CREATE TABLE `managed_agent_versions` (
	`agent_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`version` integer NOT NULL,
	`document` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `version`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_agent_versions_workspace_agent` ON `managed_agent_versions` (`workspace_id`,`agent_id`,`version`);--> statement-breakpoint
CREATE TABLE `managed_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`document` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_managed_agents_workspace_created_id` ON `managed_agents` (`workspace_id`,`created_at`,`id`);
