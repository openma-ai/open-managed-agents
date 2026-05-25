-- ============================================================
-- 0002_slack_publication_first.sql
-- Slack publication-first install flow.
-- ============================================================
--
-- Old flow (cascading INSERTs across slack_installations + slack_apps + vaults
-- + slack_publications, all triggered from the OAuth callback) had a fragile
-- failure mode: any mid-flow exception (D1 timeout in vault create, etc.)
-- left a ghost slack_installations row and an orphan Slack-side App. The
-- next install attempt then 500'd on the active-install UNIQUE index.
--
-- New flow:
--
--   1. Shell create: POST /v1/integrations/slack/publications
--      → slack_publications row with status='pending_setup', no app_id,
--        no installation_id, no credentials. Just (user, agent, env, persona,
--        callback URL committed as ".../slack/oauth/pub/<pub_id>/callback").
--
--   2. Credentials submit: PATCH /v1/integrations/slack/publications/:id/credentials
--      → encrypted client_id / client_secret / signing_secret stored on the
--        publication row. Status flips to 'credentials_filled'.
--
--   3. OAuth: user clicks Install → redirect to Slack's authorize URL →
--      Slack POSTs to /slack/oauth/pub/:pubId/callback → callback handler
--      reads pub.client_secret_cipher, exchanges code for bot/user tokens,
--      then creates slack_installations + slack_apps + vaults + binds them
--      back onto the publication row. Status flips to 'live'.
--
-- Everything before step 3 is idempotent at the publication-row level —
-- re-pasting wrong creds just overwrites cipher columns. No more orphan
-- rows on retry.
--
-- All new columns are NULLABLE and additive. Existing live publications
-- (status='live' with installation_id NOT NULL) keep working untouched.
--
-- Note: slack_apps.publication_id stays UNIQUE because each Slack App row
-- still binds to exactly one publication (just later in the flow).

-- ─── slack_publications: credential staging columns ────────────────────
-- New columns to support pre-OAuth credential staging. All nullable so
-- existing rows (legacy live publications) parse identically.
--
-- Notes:
--  * client_id is plaintext (it's a public-ish OAuth app id). client_secret
--    and signing_secret are AES-GCM encrypted with PLATFORM_ROOT_SECRET +
--    label "integrations.tokens" (same crypto as installations + model_cards).
--  * app_id is the Slack-side App id (e.g. A07ABC…). Set on OAuth callback
--    so we can find publication by Slack-app-id after install.
--  * The base slack_publications row's installation_id column is currently
--    NOT NULL. We can't relax that without a non-additive migration on D1.
--    Workaround: shell create writes installation_id="" (empty string) as
--    a sentinel for "not yet bound", flipped to a real id on OAuth complete.

ALTER TABLE "slack_publications" ADD COLUMN "client_id"             TEXT;
ALTER TABLE "slack_publications" ADD COLUMN "client_secret_cipher"  TEXT;
ALTER TABLE "slack_publications" ADD COLUMN "signing_secret_cipher" TEXT;
ALTER TABLE "slack_publications" ADD COLUMN "slack_app_id"          TEXT;

CREATE INDEX IF NOT EXISTS "idx_slack_publications_slack_app_id"
  ON "slack_publications" ("slack_app_id");
