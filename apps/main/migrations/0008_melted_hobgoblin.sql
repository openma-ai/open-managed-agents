CREATE TABLE `managed_environments` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_environments_workspace_created_id` ON `managed_environments` (`workspace_id`,`created_at`,`id`);