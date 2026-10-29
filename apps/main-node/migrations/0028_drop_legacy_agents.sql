-- Refuse to drop agents that were not moved to managed_agents.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "agents") OR EXISTS (SELECT 1 FROM "agent_versions") THEN
    RAISE EXCEPTION 'agents or agent_versions still has rows; move them to managed_agents before upgrading';
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "agent_versions" CASCADE;--> statement-breakpoint
DROP TABLE "agents" CASCADE;