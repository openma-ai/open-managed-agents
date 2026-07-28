-- ============================================================
-- Linear publication-first install flow.
-- ============================================================
--
-- The pre-existing install flow created `linear_installations`,
-- `linear_publications`, and a vault inside the OAuth callback. Mid-flow
-- failures (D1 timeout, OAuth code reuse, etc.) produced ghost rows that
-- broke retries on the active-install UNIQUE index.
--
-- New flow keeps the publication row as the single anchor for the install:
--
--   1. POST  /v1/integrations/linear/publications      → row, status='pending_setup'
--   2. PATCH /v1/integrations/linear/publications/:id/credentials
--                                                       → status='awaiting_install'
--   3. GET   /linear/oauth/pub/:pubId/callback         → status='live'
--
-- The credentials previously held in `linear_apps` (one row per OAuth app
-- baked at step 2 of the old flow) now live directly on the publication row,
-- keyed by `pub_id`. The `linear_apps` table stays in place for legacy
-- installs already in flight; new pubs never write to it.
--
-- All migrations here are additive (ALTER ADD COLUMN). `installation_id`
-- stays NOT NULL on the publications row — pending pubs use the empty
-- string sentinel until step 3 binds the real installation.

ALTER TABLE "linear_publications" ADD COLUMN "client_id"            TEXT;
ALTER TABLE "linear_publications" ADD COLUMN "client_secret_cipher" TEXT;
ALTER TABLE "linear_publications" ADD COLUMN "webhook_secret_cipher" TEXT;
-- Reserved for future use. Linear's OAuth flow doesn't use a separate signing
-- secret today (the webhook secret doubles as the HMAC key), but the column
-- is here so the route handler can stash anything the upstream returns
-- without another migration.
ALTER TABLE "linear_publications" ADD COLUMN "signing_secret_cipher" TEXT;
-- Vault id holding the bearer credential for the dedicated install. Mirrors
-- linear_installations.vault_id but lets the publication-first flow record
-- the binding before the installation row exists.
ALTER TABLE "linear_publications" ADD COLUMN "vault_id"             TEXT;

-- Return-url + persona-fields are already on the row; we don't need to
-- store the OAuth state JWT — the callback handler verifies it inline.

-- New index for the OAuth callback path: gateway resolves a webhook by
-- pub_id and needs cheap lookup. The PRIMARY KEY already covers `id`,
-- so no additional index is needed. Logged here for clarity.
