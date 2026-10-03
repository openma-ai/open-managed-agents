# @openma/self-host

A standalone OpenMA self-host installer. It does not add commands to the `oma`
API CLI and does not clone or compile the application on your machine.

This package is being introduced in this PR; the npm commands below become
available after its first npm release and trusted-publisher setup.

```sh
npx @openma/self-host
# Or install the executable:
npm install -g @openma/self-host
oma-self-host install --target docker
oma-self-host doctor --target docker --json
oma-self-host status
oma-self-host upgrade --image ghcr.io/openma-ai/open-managed-agents:YOUR_RELEASE
```

Requires Node.js 22+. Docker requires Compose with `--wait`; Fly requires Bash,
openssl, flyctl, and `fly auth login`. Set E2B_API_KEY, DAYTONA_API_KEY, BOXRUN_URL, or SPRITES_TOKEN
in your terminal environment, and select `--provider e2b|daytona|boxrun|sprites`.
Credentials are never accepted as CLI arguments. `--yes` confirms the displayed
plan for unattended runs. Use `--data-mode postgres` for Postgres instead of SQLite.

## Platform support

| Target | Behavior |
| --- | --- |
| docker | Pull a published image, configure secrets/volumes, start and check health |
| fly | Bundle Fly configuration and setup script, deploy a pinned image with flyctl |
| render | Authorize with the official Render CLI, create an image service with a disk, and check health |
| vercel | Print the Beta configurator URL; saved state explicitly remains `handoff` |
| cloudflare | Explain the missing standalone artifact and link the source-based setup guide |

Vercel provisioning still requires its web flow. Verify the resulting
instance with `oma-self-host status --url https://YOUR-SERVICE`. A template handoff
is never reported as a completed installation. Cloudflare standalone publishing
is a separate prerequisite; this package does not hide a full source checkout.

## Images and persistence

Default image channel is `edge` (development builds, not a stable release).
The installer resolves it to a SHA256 digest before deployment; use `--image`
to choose an audited release. Existing installs keep their selected digest until
an explicit upgrade. Current server images are amd64; ARM Docker hosts need
emulation. Private/unpublished tags fail before provisioning.

Each `--dir` gets a stable Compose project/volume name. Configuration defaults to
`~/.openma/self-host/<target>`; keep it with your backups. `environment.json` and
`compose.json` contain credentials and are created with mode 0600. Docker binds
localhost by default. For VPS use, set PUBLIC_BASE_URL and GATEWAY_ORIGIN in
`environment.json` to the HTTPS reverse proxy origin, then rerun install.

Reruns preserve credentials and persistent volumes. Failed attempts remain
`pending`; rerun the same command after fixing the reported error. Upgrades save
`compose.previous.json`, but database migrations are not automatically reversible:
back up databases and volumes before upgrading. Changing database engines needs
an explicit migration. No automatic volume deletion or automatic rollback occurs.

Model credentials can be added in Console after installation. Remote vault egress
and memory mounts, when needed, require separate configuration.

## Develop and validate

From this repository: `pnpm --filter @openma/self-host build`, then
`node packages/self-host/dist/index.js --help`. The published package contains only
bundled JavaScript, Fly assets, and this README; the YAML parser is bundled and there are no runtime npm dependencies.

### Existing Fly apps

Save the existing app's configuration as `<directory>/fly.toml`, then run:

```sh
oma-self-host install --target fly --provider sprites --dir <directory> --reuse-fly-secrets
```

This checks required secret names in the app and reuses their values without
exporting or overwriting them. Select the provider already configured on the app.
Subsequent installs and upgrades remember this choice. Installation is only
marked complete after the public `/health` endpoint succeeds.

### Render authorization and deployment

Install the official Render CLI, then use `oma-self-host install --target render`.
It calls `render login` and resumes after browser authorization. Choose an active
workspace in Render CLI, or pass `--workspace ID`. `--region` defaults to `oregon`.
Review the paid `1c-2g` service and 10 GB disk before confirming. SQLite only.
The platform token remains in Render CLI configuration (or `RENDER_API_KEY` for CI).
Provider credentials and generated application secrets remain in private local
configuration and are sent directly to Render, never to the OpenMA website.

`oma-self-host login --target render|fly|vercel|cloudflare` delegates to the
installed official platform CLI. Render deployment is implemented; Vercel and
Cloudflare login support does not imply automated deployment support.
