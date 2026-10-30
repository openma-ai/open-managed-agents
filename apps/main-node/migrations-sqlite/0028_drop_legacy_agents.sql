-- Retain empty legacy agent tables; refuse retirement until their rows are moved.
-- Node moves them before this migration runs; D1 uses scripts/migrate-legacy-agents.ts.
-- Keep the historical migration name and snapshot IDs for already upgraded databases.
CREATE TABLE `legacy_agents_guard` (`unconverted` integer NOT NULL CHECK (`unconverted` = 0));--> statement-breakpoint
INSERT INTO `legacy_agents_guard` SELECT (SELECT COUNT(*) FROM `agents`) + (SELECT COUNT(*) FROM `agent_versions`);--> statement-breakpoint
DROP TABLE `legacy_agents_guard`;