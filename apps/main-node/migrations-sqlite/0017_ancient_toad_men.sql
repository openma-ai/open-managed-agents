CREATE TABLE `managed_deployment_runs` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer NOT NULL,
	`has_error` integer NOT NULL,
	`trigger_type` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_deployment_runs_workspace_created_id` ON `managed_deployment_runs` (`workspace_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_managed_deployment_runs_workspace_deployment_created_id` ON `managed_deployment_runs` (`workspace_id`,`deployment_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `managed_deployments` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`document` text NOT NULL,
	`sealed_resource_secrets` text NOT NULL,
	`revision` integer NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_deployments_workspace_created_id` ON `managed_deployments` (`workspace_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_managed_deployments_workspace_agent_created_id` ON `managed_deployments` (`workspace_id`,`agent_id`,`created_at`,`id`);