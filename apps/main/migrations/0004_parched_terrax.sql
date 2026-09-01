CREATE TABLE `managed_session_resource_secrets` (
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`secret_type` text NOT NULL,
	`sealed_value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `session_id`, `resource_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_session_resource_secrets_workspace_session` ON `managed_session_resource_secrets` (`workspace_id`,`session_id`);