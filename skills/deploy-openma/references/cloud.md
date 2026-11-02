# Cloud deployment paths

Read the selected target only. Paths below refer to the **server checkout**.
Provider operations may create billable resources or update an existing app;
confirm the account, project/app, region and intended scope first.

## Cloudflare

Read `scripts/setup-cf.sh`, `apps/docs/src/content/docs/self-host/deploy.mdx`,
and the relevant Wrangler configs in `apps/main`, `apps/agent` and
`apps/integrations` before running setup.

- Check the checkout's Node and pinned pnpm versions, Docker/container-build
  support, `jq`, `openssl`, Wrangler authentication and required Workers/Containers
  services. Let the user complete `wrangler login` if necessary.
- Inspect resource names and existing account resources: the setup script reuses
  named resources and updates local config. A "fresh install" must not adopt an
  unrelated deployment's databases or buckets.
- Current setup prompts for an Anthropic key unless supplied in its environment.
  Do not promise credential-free setup or print the key. If the user wants a
  different model/provider, investigate the checked-out setup path instead of
  silently requiring an unrelated account.
- After prerequisites and approval, use `pnpm install --frozen-lockfile` and
  `pnpm setup:cloudflare` from the checkout. Inspect secret handling first; do
  not use reset-secret options against an existing deployment without a rotation
  and recovery plan. Preserve generated configuration and key backup information.
- Use the emitted deployment URL, never the hosted OpenMA domain. Verify Console,
  authenticated execution and storage; successful resource creation is not proof
  that an agent can run.

## Fly.io

Read `scripts/setup-fly.sh`, `fly.toml`,
`apps/docs/src/content/docs/self-host/fly.mdx` and `apps/main-fly/`.

- Check `fly`, `openssl`, authentication and the selected app/organization/region.
  The script may launch a new app or update the app selected by the local config.
- Select `OPENMA_FLY_DATA_MODE` (`sqlite` or `postgres`) and
  `OPENMA_FLY_SANDBOX_PROVIDER` (`e2b`, `daytona` or `boxrun` in the reviewed script).
  Supply provider secrets through a protected environment. Preserve existing
  application secrets; check they actually exist for an already-created app.
- The default release image resolves from the checkout's full Git SHA. Verify
  that image exists and is accessible before deployment. Use a verified immutable
  `OPENMA_FLY_IMAGE` where appropriate. Do not fall back to `latest`; source-build
  mode (`OPENMA_FLY_BUILD_FROM_SOURCE=1`) is an explicit choice, not a hidden retry.
- After preparation and approval, run `bash scripts/setup-fly.sh` from the checkout
  (the `pnpm setup:fly` alias invokes the same script). Inspect staged secrets,
  volume provisioning and deployment behavior without printing secret values.
- Keep SQLite at one Machine. Confirm volume mounting, public origin, required
  storage and reachable credential egress. `fly checks list` and `/health` precede
  the Console and agent-task checks; they do not replace them.

## Vercel (Beta)

Read `vercel.json`, `apps/main-vercel/src/production.ts`,
`apps/main-vercel/scripts/build-function.mjs`, and the Vercel section of
`apps/web/src/lib/deploy-wizard.ts`. Use the current deployment chooser at
https://openma.ai/deploy/ only as a guide to the actual configuration.

This target has a bounded serverless control plane and an in-sandbox execution
path. It is not the single-process Node/Docker deployment copied into a Function.
Check the current requirements for Postgres, object storage, authenticated vault
egress, a Sandbox snapshot with the selected worker/harness, environment
credentials, signed webhooks and cron authorization. A deploy button does not
configure all those services or prove runtime readiness.

Confirm the Vercel team/project and each storage integration's cost/region. Let
users complete provider logins and enter secrets directly in the provider's
protected settings. Build/deploy using the pinned commands in the checkout;
do not promote to production unless requested. Verify authenticated work dispatch
and an actual sandbox turn before reporting the platform ready for use. Describe
any unmet runtime requirement rather than removing checks to make a build green.
