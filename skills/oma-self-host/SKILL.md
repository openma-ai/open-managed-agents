---
name: oma-self-host
description: Install, diagnose, check, or upgrade a self-hosted OpenMA instance using the standalone oma-self-host installer. Use for hosting OpenMA on Docker/VPS, Fly or Render, or navigating Vercel setup. This is infrastructure installation, not creating agents or sessions on an existing OpenMA API.
---

# Self-host OpenMA

Use the `@openma/self-host` package and its `oma-self-host` executable. Do not add deployment commands to
`oma`, invent a platform API, or clone the application just to run Docker.

The package is introduced in this repository and must complete its first npm
release before `npx @openma/self-host` works. Until published, follow
`packages/self-host/README.md` to build and run the installer from the checkout.
Do not claim the package is published without checking.

1. Determine the platform, installation directory, and SQLite/Postgres choice.
   Reuse an existing directory when diagnosing or resuming an installation.
2. Run `oma-self-host doctor --target <platform> --dir <directory> --json`.
   Report missing tools or login requirements. Do not request credentials in chat;
   the user provides them in their terminal environment.
3. Explain the plan and relevant hosting/sandbox charges. Use
   `oma-self-host install --target <platform> --dir <directory>` interactively.
   Use `--yes` only when the user has authorized the concrete resource changes.
4. Docker/Fly use released images. The default `edge` channel is a development
   build; select an explicit audited `--image` when required. ARM Docker uses
   amd64 emulation. Do not call a source build a one-click binary installation.
5. Report success only after health verification. Vercel currently outputs
   a browser handoff, not a completed installation. Cloudflare has no standalone
   artifact yet and the CLI refers to the source-based deployment guide.
6. Verify hosted results with `oma-self-host status --url https://HOST`.
   For an upgrade, preserve secrets and data, confirm a backup exists, and use
   `oma-self-host upgrade --image <official-image> --dir <directory>`.

Failed installs retain pending state. Correct the specific error and rerun the
same command. Do not delete volumes, rotate application secrets, or switch
storage engines to get past an error. Report pending/handoff states accurately.

Render uses the official `render login` browser flow and resumes in the CLI. Configure provider credentials locally; platform authorization does not require a GitHub repository connection. Show workspace, region and paid service/disk before deploying. Vercel remains a handoff and Cloudflare remains source-based.
