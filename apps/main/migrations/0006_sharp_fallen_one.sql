CREATE TABLE `managed_session_threads` (
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`document` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`workspace_id`, `session_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_managed_session_threads_workspace_session_created_id` ON `managed_session_threads` (`workspace_id`,`session_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `managed_session_events` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `idx_managed_session_events_workspace_thread_time_id` ON `managed_session_events` (`workspace_id`,`session_id`,`thread_id`,`processed_at`,`id`);