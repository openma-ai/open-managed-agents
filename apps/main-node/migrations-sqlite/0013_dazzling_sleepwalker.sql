CREATE TABLE `managed_credentials` (
	`workspace_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`id` text NOT NULL,
	`sealed_document` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_credentials_workspace_vault_created_id` ON `managed_credentials` (`workspace_id`,`vault_id`,`created_at`,`id`);