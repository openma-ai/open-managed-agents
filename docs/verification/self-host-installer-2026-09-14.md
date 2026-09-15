# Self-host installer acceptance — 2026-09-14

The npm package is `@openma/self-host`; the executable is `oma-self-host`.
It is not published yet. Tests below use compiled distribution files outside the
repository, initially extracted from `npm pack`, plus the updated Fly reuse path.

## Verified

- Docker SQLite and Postgres: real published image installation on Docker Desktop,
  repeat installation, explicit-image upgrade, doctor and status. Credentials
  remained unchanged; a file survived container recreation. A Postgres table row
  also survived. API health succeeded on ports 18787 and 18788. Account signup,
  container recreation and signin also passed on both database configurations.
- Fly: historical app `red-pinecone-121` has eight completed releases from
  September 10–11. It had no Machines at the start of this acceptance run.
  Its existing 10 GB volume and Sprites secrets were preserved. A volume snapshot
  was requested before deployment. The published image was deployed, then the
  standalone installer was exercised with `--provider sprites --reuse-fly-secrets`.
  Installation, explicit-image upgrade and public status succeeded; a marker in
  `/app/data` survived upgrade. Public endpoint:
  <https://red-pinecone-121.fly.dev/health>.
- Published image tested:
  `ghcr.io/openma-ai/open-managed-agents@sha256:64aa859afb4866c70869839d6b8c10843a047a407ba8cf9007ad2750440b7578`.
  Upgrade tests deliberately selected this same digest: they verify command flow
  and preservation, not compatibility between different database schema versions.
- Nine installer tests and twelve Fly setup tests pass. Package typechecking passes.
  Root CI's Cloudflare/Node typecheck conflict is fixed; the subsequent CI typecheck
  passed. The complete latest CI run remains a merge prerequisite.
- Server-image CI on commit c618a2fb completed its actual image build, health check,
  container recreation and volume persistence check.

## Not yet certified

- Docker tests use an explicit placeholder E2B key and do not call a sandbox.
  No paid sandbox/model agent task was executed in this acceptance run.
- Render: browser flow reaches GitHub authorization. New authorization is pending;
  no Render service was provisioned. The Blueprint also requires E2B credentials.
- Vercel: existing GitHub login succeeds. The clone flow reached mandatory Neon
  integration installation and environment configuration for the acceptance repo.
  Neon terms/information sharing approval and object-storage credentials are pending.
  The account currently selects Hobby; the checked-in every-minute production cron
  requires a plan supporting that frequency. See
  <https://vercel.com/docs/cron-jobs/usage-and-pricing>.
- Cloudflare: local Wrangler authorization is expired and refresh failed.
  A new login is needed to run source deployment certification. The independent
  installer currently exposes its source guide, not an artifact-only installation.
- npm first publication and release workflow have not been exercised.

Local acceptance artifacts and logs are in `/tmp/openma-self-host-acceptance`.
They include private generated configuration; do not commit or share that directory.
