# Node / Docker: single-host deployment

Paths below are relative to the **server checkout**, not this skill directory.

## Inspect and prepare

Read `.env.example`, `docker-compose.yml`, `apps/main-node/Dockerfile`,
`apps/main-node/src/sandbox-provider.ts` and
`apps/docs/src/content/docs/self-host/node-docker.mdx`. For sandbox network,
resource and recovery requirements, read the relevant sections of
`apps/docs/src/content/docs/self-host/managed-runtime-host.mdx`.

Check OS/architecture, available disk, Docker daemon and Compose version, port
availability, and permissions on the chosen persistent directory. Compare image
Node/pnpm versions with the checked-out workspace requirements before a lengthy
build. Do not silently change runtime versions or ignore engine checks.

For a native Node deployment, use the checkout's Node/pnpm versions and inspect
`apps/main-node/package.json` and `apps/main-node/src/config.ts` for commands and
paths. The repository's single-host storage choice remains useful; Docker-specific
network names and paths do not apply to a native process.

## Prepare configuration for the user

1. Keep SQLite and local filesystem storage for a first single-host trial unless
   the user chose a server database. Preserve an existing `.env`; for a new
   install, write only the selected configuration. Do not copy `sk-...` or other
   sample credentials as real values, or execute an untrusted `.env` with `source`.
2. Generate missing `BETTER_AUTH_SECRET` and `PLATFORM_ROOT_SECRET` using a secure
   local RNG. The repository documents `openssl rand -hex 32` and
   `openssl rand -base64 32`, respectively. Write results directly into protected
   configuration, not terminal output. Use owner-only file permissions where
   supported, exclude secrets from Git, and explain that the root key must be
   backed up with encrypted data.
3. Set `PUBLIC_BASE_URL` to the actual origin. Keep authentication on. Let the user
   add model credentials in Console Model Cards; a global Anthropic key is not a
   prerequisite for every model choice.
4. Set a supported isolated `SANDBOX_PROVIDER` and its required configuration.
   Inspect the actual adapter before choosing defaults:
   - E2B / Daytona: need provider access and reachable services. Check template,
     tool and network requirements before allocating a paid sandbox.
   - LiteBox: check host virtualization support and its availability **inside the
     chosen deployment**, not just on the physical host. Docker Desktop is not
     proof that a nested sandbox can run.
   - BoxRun: needs an existing reachable service and matching runtime capabilities.
   Do not treat an adapter name as proof that all resource/security features work.
5. Check sandbox reachability to the ordinary HTTPS `PUBLIC_BASE_URL`.
   Vault egress uses `/v1/oma/egress`; no additional TCP listener is required.
   Local interception belongs to the sandbox (or its native outbound adapter).
   Environment proxy variables are bypassable; do not present them as isolation.

For local trials, bind the Console/API host port to `127.0.0.1`. The bundled
Compose mapping may bind all interfaces. Use a local deployment configuration
that **replaces** the published port; a naive Compose override can append a
second port instead. Inspect effective port bindings before starting. Use the
installed Compose version's supported replacement mechanism or a dedicated
local Compose file with correct relative paths. Do not make an unrelated public
service private or change its bind address without the user's agreement.

## Start and check

Validate the actual configuration before starting. `docker compose config --quiet`
validates without dumping interpolated secrets. Inspect other resolved settings
through a redacted projection. Keep the same `--env-file`, `-f` and project options
on every subsequent command when using a nondefault configuration.

For the bundled configuration, after completing the prerequisites:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl --fail http://localhost:8787/health
```

Substitute the chosen port and configuration arguments. Inspect sanitized logs
on failure. Check that bind-mounted data is writable by the container user;
correct ownership narrowly instead of applying world-writable permissions.

Open the Console and follow the verification workflow in `SKILL.md`. Use the
checkout's current SDK examples and authentication flow, not stale unauthenticated
curl snippets. Preserve `./data` (or the selected data directory) across restarts.
Do not run `down -v`, prune volumes, or delete data to retry startup.

For public deployments, additionally configure HTTPS, the real public origin,
backups, and provider-appropriate credential isolation before exposing the
service. Keep a single replica for the initial SQLite deployment.
