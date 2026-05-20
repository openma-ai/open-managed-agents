-- ============================================================
-- 0002_github_publication_first.sql
-- GitHub publication-first install flow.
-- ============================================================
--
-- Old flow (cascading INSERTs across github_installations + github_apps +
-- vaults + github_publications, all triggered from the install callback)
-- had the same fragile failure mode Slack hit: any mid-flow exception (D1
-- timeout in vault create, GitHub installation_token mint failing, etc.)
-- left a ghost github_installations row and an orphan github_apps row. The
-- next install attempt then 500'd on the active-install UNIQUE index, or
-- worse, the github_apps row's PRIMARY KEY conflict made re-submit
-- impossible without manual cleanup.
--
-- New flow:
--
--   1. Shell create: POST /v1/integrations/github/publications
--      → github_publications row with status='pending_setup',
--        installation_id="" (sentinel — the column is NOT NULL in storage),
--        no credentials. Just (user, agent, env, persona) plus a freshly
--        minted app_oma_id so the webhook URL — /github/webhook/app/<appOmaId> —
--        is stable from minute one. agent_id and environment_id are FIXED
--        at create time (no PATCH for them).
--
--   2. Credentials submit: PATCH /v1/integrations/github/publications/:id/credentials
--      → encrypted client_secret / webhook_secret / private_key columns set
--        on the publication row, plus the plaintext app_id / app_slug /
--        bot_login the user pasted (verified against GitHub's GET /app
--        before write). Status flips to 'credentials_filled'. Idempotent
--        re-paste overwrites the same columns — no second row created.
--
--   3. Install: user clicks the install link → GitHub's
--      /apps/<slug>/installations/new?state=<jwt> → GitHub redirects to
--      /github/oauth/pub/:pubId/callback with installation_id. Callback
--      reads pub.private_key_cipher, mints an installation token via App
--      JWT, creates the vault, writes installation_id + vault_id back onto
--      the publication row. Status flips to 'live'.
--
-- Everything before step 3 is idempotent at the publication-row level —
-- re-pasting wrong creds just overwrites cipher columns. No more orphan
-- rows on retry.
--
-- All new columns are NULLABLE and additive. Existing live publications
-- (status='live' with installation_id NOT NULL) keep working untouched.
--
-- Notes:
--  * app_oma_id is our internal id for the github_apps row this publication
--    binds to. Pre-minted at shell create so the webhook URL the user
--    pastes into GitHub's "Webhook URL" field at App registration time
--    matches what our gateway will receive deliveries on.
--  * client_id / app_id / app_slug / bot_login are plaintext (public-ish).
--    client_secret / webhook_secret / private_key are AES-GCM encrypted
--    with PLATFORM_ROOT_SECRET + label "integrations.tokens" (same crypto
--    as installations + slack_publications + model_cards).
--  * vault_id is set on OAuth callback once the installation token is
--    minted and stashed. Mirrors github_installations.vault_id so a
--    publication can answer "where do I send my MCP traffic" without
--    JOINing through installation_id.
--  * github_apps and github_installations are still written on install
--    callback (transitional dual-write so the legacy webhook fallback path
--    still resolves — see provider.ts handleWebhook).

ALTER TABLE "github_publications" ADD COLUMN "app_oma_id"            TEXT;
ALTER TABLE "github_publications" ADD COLUMN "client_id"             TEXT;
ALTER TABLE "github_publications" ADD COLUMN "client_secret_cipher"  TEXT;
ALTER TABLE "github_publications" ADD COLUMN "app_id"                TEXT;
ALTER TABLE "github_publications" ADD COLUMN "app_slug"              TEXT;
ALTER TABLE "github_publications" ADD COLUMN "bot_login"             TEXT;
ALTER TABLE "github_publications" ADD COLUMN "webhook_secret_cipher" TEXT;
ALTER TABLE "github_publications" ADD COLUMN "private_key_cipher"    TEXT;
ALTER TABLE "github_publications" ADD COLUMN "vault_id"              TEXT;

-- Lookup by app_oma_id for the webhook handler's primary path.
CREATE INDEX IF NOT EXISTS "idx_github_publications_app_oma_id"
  ON "github_publications" ("app_oma_id");

-- Lookup by GitHub's numeric app_id, for ops "find the publication for app 7654321".
CREATE INDEX IF NOT EXISTS "idx_github_publications_app_id"
  ON "github_publications" ("app_id");
