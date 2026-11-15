-- Cross-shard backfill clears source publications only after read-back verification.
-- An unbackfilled publication aborts this migration before any DROP.
CREATE TABLE IF NOT EXISTS runtime_publication_drop_guard (remaining INTEGER NOT NULL CHECK (remaining = 0));--> statement-breakpoint
INSERT INTO runtime_publication_drop_guard SELECT count(*) FROM runtime_resource_fences WHERE publication_json IS NOT NULL;--> statement-breakpoint
DROP TABLE runtime_resource_fences;--> statement-breakpoint
DROP TABLE runtime_publication_drop_guard;
