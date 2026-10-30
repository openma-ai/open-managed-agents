-- Retain empty legacy agent tables; refuse retirement until their rows are moved.
-- Keep the historical migration name and snapshot IDs for already upgraded databases.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "agents") OR EXISTS (SELECT 1 FROM "agent_versions") THEN
    RAISE EXCEPTION 'agents or agent_versions still has rows; move them to managed_agents before upgrading';
  END IF;
END $$;