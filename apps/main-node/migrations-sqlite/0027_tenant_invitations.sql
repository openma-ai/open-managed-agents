CREATE TABLE `tenant_invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_by` text,
	`claim_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_invitation_token_hash_unique` ON `tenant_invitation` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_tenant_invitation_tenant` ON `tenant_invitation` (`tenant_id`);