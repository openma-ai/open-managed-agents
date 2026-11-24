CREATE TABLE `managed_tool_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`session_thread_id` text,
	`tool_use_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`args_json` text NOT NULL,
	`concurrency` text NOT NULL,
	`resource_key` text,
	`created_at_ms` integer NOT NULL,
	`available_at_ms` integer NOT NULL,
	`state` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`owner_id` text,
	`attempt_id` text,
	`generation` integer,
	`claimed_at_ms` integer,
	`lease_expires_at_ms` integer,
	`result_json` text,
	`cancelled_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_tool_requests_idempotency_key_unique` ON `managed_tool_requests` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `managed_tool_requests_poll_idx` ON `managed_tool_requests` (`state`,`available_at_ms`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `managed_tool_requests_scope_idx` ON `managed_tool_requests` (`workspace_id`,`session_id`,`state`,`lease_expires_at_ms`);
