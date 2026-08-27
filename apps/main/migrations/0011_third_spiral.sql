CREATE TABLE `managed_user_profiles` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_user_profiles_workspace_created_id` ON `managed_user_profiles` (`workspace_id`,`created_at`,`id`);