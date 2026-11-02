-- Refuse to drop agents that were not moved to managed_agents. Node moves them
-- before this migration runs; a D1 operator runs scripts/migrate-legacy-agents.ts.
CREATE TABLE `legacy_agents_guard` (`unconverted` integer NOT NULL CHECK (`unconverted` = 0));--> statement-breakpoint
INSERT INTO `legacy_agents_guard` SELECT (SELECT COUNT(*) FROM `agents`) + (SELECT COUNT(*) FROM `agent_versions`);--> statement-breakpoint
DROP TABLE `legacy_agents_guard`;--> statement-breakpoint
DROP TABLE `agent_versions`;--> statement-breakpoint
DROP TABLE `agents`;