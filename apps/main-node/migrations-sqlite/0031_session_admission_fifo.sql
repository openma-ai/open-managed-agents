CREATE TABLE `managed_session_admission_counters` (
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`workspace_id`, `session_id`)
);
--> statement-breakpoint
ALTER TABLE `managed_session_executions` ADD `admission_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `managed_session_executions_admission_idx` ON `managed_session_executions` (`workspace_id`,`session_id`,`lane_id`,`admission_sequence`);