# GitHub Actions in this repo

This repo's CI publishes the OSS source — npm packages, sandbox container
image. **It does NOT deploy any worker to a Cloudflare account.**

| Workflow | Purpose |
|---|---|
| `ci.yml` | Graded impact-surface CI (#417). `changes` classifies the diff; `docs` / `web` / `cf` / `node` run only when needed; `release-check` stays a cheap PR job; `verify` is the branch-protection gate (skipped surfaces count as success) |
| `release.yml` | Frozen `release` cut (~every 2 days / `workflow_dispatch`) → Version Packages targets `release`; `publish` on Version Packages merge to `release` (`scripts/release-check.mjs --publish` then `pnpm release`) publishes `@openma/cli` / `@openma/sdk` to npm via changesets + OIDC trusted publisher, then sync PR `release` → `main` |
| `build-sandbox-image.yml` | builds the agent sandbox base image for OSS users to pull |
| `build-server-image.yml` | verifies and publishes the Node/Console server image to GHCR under an immutable full-Git-SHA tag; release tags add a human version alias |

## Graded CI surfaces (`ci.yml`)

Classifier: `scripts/ci-impact-surfaces.mjs` (tests in
`scripts/ci-impact-surfaces.test.mjs`).

| Surface | Typical paths | Job | Runs |
|---|---|---|---|
| **docs** | `apps/docs/**` | `docs` | docs typecheck + `pnpm build:docs` |
| **web** | `apps/web/**` | `web` | web typecheck + `pnpm test:web` |
| **cf** | CF apps (`main`, `agent`, `integrations`, `matter`, `oma-vault`), `*cloudflare*` / `cf-billing` / `integrations-adapters-cf` packages, root Cloudflare Vitest / wrangler test config, CF scripts | `cf` | `typecheck:ci:cf` + `test:ci:cf` (Cloudflare Vitest pool + CF package tests). **No** KVM / MySQL / Postgres / console E2E |
| **node** | Node apps (`main-node`, `main-fly`, `main-vercel`, `console`), sandbox / node-database / cli / sdk / other Node packages, Playwright + non-CF vitest configs | `node` | `typecheck:ci:node` + `test:ci:node` + E2E / coverage / storage / KVM / MySQL / Postgres. **No** root Cloudflare Vitest pool |
| **shared / unknown** | `.github/workflows/ci.yml`, `.github/actions/**`, packages used by both runtimes, or lockfile with neither cf nor node code | `cf` **and** `node` | full PR coverage |
| **meta** | root markdown, `docs/**`, license, unrelated workflow files | _(none)_ | `verify` still succeeds |

Lockfile / root `package.json` rule: a CF Dependabot bump that touches
`pnpm-lock.yaml` plus CF manifests (no Node app/package paths) runs **`cf`
only** — it must not pay the Node/MySQL tax. Symmetrically, Node-only +
lockfile skips **`cf`**. Lockfile alone still runs both.

Branch protection requires the check named **`verify`**. That job always
runs (`if: always()`) and passes when every needed job is `success` or
`skipped`.

## Why no deploy workflows?

Earlier versions of this repo had `deploy.yml`, `deploy-staging.yml`,
`deploy-lane.yml`, etc. Those were removed because:

1. **Repo / deploy concern separation.** A deploy workflow in OSS
   couples this codebase to one operator's CF account. Anyone forking
   for self-host had to either re-wire the workflows or accept a red
   CI badge — neither is good.

2. **Hosted overlay needs to win.** The OSS `apps/*/wrangler.jsonc`
   files are templates; production deployments overlay extra bindings
   (e.g. a billing-meter service binding, real D1 IDs, custom domains).
   Letting OSS auto-deploy on `push: main` clobbered those overlays.

## Self-host deploy

You're on your own — fork the repo, fill in `apps/*/wrangler.jsonc`
with your CF resource IDs, run `wrangler deploy` from each app dir.
The hosted operator's deploy infra (separate private repo) is
documented in their own README and is not maintained here.

## OMA hosted

Deploys run from the operator's private `openma-hosted` repo via its
own GitHub Actions workflows. The `.oma-version` file there pins which
SHA of this repo gets shipped to prod.
