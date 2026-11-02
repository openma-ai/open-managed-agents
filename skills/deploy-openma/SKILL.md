---
name: deploy-openma
description: >
  Deploy and self-host the OpenMA platform on a local machine, server, or cloud.
  Use when users ask to install OpenMA, bring up its Console and API, configure
  a self-hosted deployment, or troubleshoot first-boot setup on Node/Docker,
  Cloudflare, Fly.io, or Vercel. Not for merely creating an agent on an existing
  OpenMA instance.
---

# Deploy OpenMA

Help the user reach a working OpenMA Console and a verified agent task. Do the
setup work rather than handing back a list of environment variables. This skill
is a deployment workflow for a coding agent, not an executable server installer.

## Establish the target

Use the user's specified host, platform, directory and existing credentials.
Inspect what is available before asking questions. If the destination is unknown,
ask whether this is a local trial or a server/cloud deployment. For a local trial,
prefer a single-host Node/Docker setup when Docker and a supported isolated
sandbox are available. Do not assume Docker alone provides the agent sandbox.

Keep questions to missing decisions or access: destination, sandbox choice,
provider login and credentials. Generate application secrets and choose ordinary
single-host storage defaults yourself. Do not require users to choose a database,
queue or object store unless their deployment needs it.

Before provisioning, state the target, data location, exposure and any paid
services. Obtain approval for costs or public exposure not already authorized.
Do not switch cloud accounts, deploy to production or replace an existing
installation merely because it is accessible.

## Use the actual release

Repository: https://github.com/openma-ai/open-managed-agents

Reuse a suitable checkout or clone into an agreed, unused directory. Preserve
local changes. Record the release/ref and resolved commit; do not assume the
installed skill's directory is a server checkout. Read the checkout's `AGENTS.md`,
`.node-version`, `package.json` and the selected target's configuration.

Use a user-selected release, or an identified published release. For a source
trial, disclose the selected commit. Do not invent a Docker image tag or assume
every Git commit has a published image. Compare current entrypoints and config
with documentation when they disagree; report build/configuration failures
rather than bypassing checks or claiming success.

Read only the selected deployment reference:

- **Node/Docker:** [single-host setup](references/node-docker.md).
- **Cloudflare, Fly.io or Vercel:** [cloud setup](references/cloud.md).

## Credentials and existing data

- Generate missing application secrets locally, save them in a protected file
  or provider secret store, and keep them stable across retries and restarts.
  Preserve existing `BETTER_AUTH_SECRET`, `PLATFORM_ROOT_SECRET`, databases and
  volumes. A lost encryption root is a recovery problem, not a reason to generate
  a replacement and declare the installation repaired.
- Let users log in through provider/browser flows. Accept API keys from a secret
  manager, protected environment or local file; do not request them in chat,
  put values in command arguments, or echo them in output. Disable shell tracing
  around secret handling. Redact logs and resolved deployment configuration.
- Keep authentication and sandbox isolation enabled. Do not use `AUTH_DISABLED`,
  test adapters, a host subprocess or unscoped credential access as a shortcut.
- For an existing install, establish backup and rollback before migrations or
  redeployment. Do not reset volumes, rotate keys or overwrite configuration to
  make a smoke test pass.

## Verify what the user can do

1. **Service ready:** check build/deploy completion, service status, sanitized
   startup logs and `/health`. Confirm the selected data storage and listening
   address. An HTTP 200 alone is not full deployment success.
2. **Console usable:** check the login page and help the user create/sign into
   the intended workspace. Never claim an account was created without evidence.
3. **Agent execution:** configure or select a Model Card and ready environment;
   use the current Console or authenticated SDK/CLI to run a small task. Verify
   model output and a harmless sandbox operation, such as writing then reading
   a temporary file, through persisted session events. Do not send private data
   to a model for testing. Respect the approved model/sandbox spending scope.
4. **Persistence:** for a fresh local trial, verify the test session remains
   accessible after a controlled restart if authorized. On an existing service,
   schedule disruptive verification rather than restarting it without agreement.

If credentials, runtime support or approval are missing, finish safe preparation
and report the exact remaining step. Distinguish **prepared**, **service ready**,
**agent execution verified**, and **persistence verified**. Do not substitute a
no-sandbox model response for sandbox verification.

Investigate a failed step using its actual error and logs. Retry only after an
identified change; recheck cloud resources before provisioning again. If progress
requires new access or a destructive action, stop that step and ask rather than
looping or silently changing the deployment design.

## Handoff

Return the Console URL, release/commit, target, storage and secret locations
(without values), verification results, and the exact start/stop/log commands
for the deployed configuration. Call out incomplete checks and backup needs.
Keep the handoff short; the user should not have to repeat the setup you did.
