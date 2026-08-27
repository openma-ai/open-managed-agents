CREATE TABLE `managed_dreams` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_dreams_workspace_created_id` ON `managed_dreams` (`workspace_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_managed_dreams_workspace_status_created_id` ON `managed_dreams` (`workspace_id`,`status`,`created_at`,`id`);