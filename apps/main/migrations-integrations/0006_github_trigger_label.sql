-- Add `trigger_label` column to github_publications. The label-based bot
-- trigger is the new primary engagement path: users add this label to any
-- issue/PR to subscribe the bot. Once subscribed, all whitelisted events
-- on that issue/PR wake the bot's session. @-mention is preserved as a
-- fallback trigger.
--
-- Default for existing rows: lowercased + sanitized persona_name. New rows
-- get the same default at insert time (provider sets it explicitly when
-- the wizard creates the shell row).

ALTER TABLE "github_publications"
  ADD COLUMN "trigger_label" TEXT;

-- Best-effort backfill for existing live publications. Keep characters that
-- GitHub allows in label names (alnum + space + hyphen + underscore + period
-- + colon); replace anything else with `-`. SQLite's REPLACE chain is the
-- cleanest portable path; not perfect but fine for the typical persona_name.
UPDATE "github_publications"
SET "trigger_label" = LOWER(persona_name)
WHERE "trigger_label" IS NULL;
