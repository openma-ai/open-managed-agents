# Contributing

This is the canonical contribution guide for the openma-ai organization. It lives in `open-managed-agents` first. To reuse it in another organization repository or an organization `.github` repository, replace the **This repository** section and update repository-specific links.

The shared rules are conventional-commit titles, squash merges, small PRs, searching for existing issues/PRs before opening new ones (bots must record the search), green CI with explained failures, compatibility checks for dependency upgrades and downstream bumps after release, private security reports, and an evidence report on every PR before merge.

## Branches

Branch from `main`. Use lowercase names for manually created branches:

```text
<type>/<kebab-summary>
```

Use the same type as the PR title. Examples from merged PRs include `fix/ci-minio-image` (#227), `feat/sql-realtime-fanout` (#222), `refactor/split-node-assembly` (#234), and `docs/discord-community` (#197). Include the issue number when applicable, for example `fix/196-session-update-idle`.

Keep tool-generated prefixes unchanged: `dependabot/…`, `codex/…`, and `cursor/…`. In deepseek-harness-acp, dsh upgrade branches use `codex/bump-dsh-<version>`.

Keep each branch focused on one task. Rebase to stay up to date with `main`.

## PR titles and squash merges

Use [Conventional Commits](https://www.conventionalcommits.org/). After squash merging, the PR title becomes the commit subject on `main`, with GitHub appending `(#number)`:

```text
<type>(<scope>): <imperative summary of the change>
```

The scope is optional. Common types are `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `ci`, and `chore`. Use `chore(deps):` for dependencies. Use one type per PR. Some historical titles do not follow this rule: #224 used `fix+feat(...)`; #237 used `Workspace persistence semantics: durable_mount vs fenced checkpoint_restore, shared Session outputs`; #239 used `CMA retry_status semantics + live-found fixes (...)`. New PRs must use a single conventional type.

Release commits use `release: vX.Y.Z` (see [Release](#release)). Do not use that prefix for ordinary PRs.

Use **squash merge**. Recent PRs on this repository's `main` each produce one single-parent commit whose subject is the PR title. #202 explicitly states that merge commits are not accepted, so dependent PRs were combined and squash-merged. deepseek-harness-acp has historical merge commits (#30); new PRs should use squash merge.

## Small PRs

Change one concern or responsibility at a time. The `main-node` control-plane extraction was a sequence of small PRs (#225, #228–#234), each changing one layer. Separate documentation, renames, and behavior changes.

When lockfiles conflict, related dependency updates may be combined into one PR with one full CI run (#202 included #201–#206). List the included PRs in the description.

## Deduplicate

**Before** opening an issue or PR, search this repository for similar work. This applies to human contributors and bots / agents alike.

1. Search open issues, recently closed issues, and open PRs. Use the symptom, the verbatim error message, and component or file names as keywords; when linking issue numbers, also search for `Fixes #N` / `#N`.
2. If similar work already exists, attach to the existing issue or keep working on the existing PR branch. Do not open a new one.
3. Additional requirement for bots / agents: before opening, record the search keywords and results (links or "no matches") in the task log or in the description about to be posted. If the results are non-empty and you still open a new one, explain why the existing issue / PR is insufficient.
4. In the "Problem / motivation" section of the evidence report, list related issues / PRs, or state explicitly "Searched, no duplicates". The PR template has a matching checkbox.

Example commands (replace `REPO` and the keywords for the current repository):

```bash
gh issue list --repo openma-ai/REPO --state open --search "<keywords>"
gh issue list --repo openma-ai/REPO --state closed --search "<keywords>" --limit 20
gh pr list --repo openma-ai/REPO --state open --search "<keywords>"
```

## Evidence report

**Before merge, the PR description or a comment must contain an evidence report for the current head SHA.** Do not merge if sections are missing or the evidence refers to an older SHA. This is not enforced by a status check: the author supplies the report and the maintainer verifies it. Use [the PR template](.github/pull_request_template.md).

Include all six sections. If a section does not apply, write “Not applicable” and explain why.

### Problem / motivation

For a bug, provide a reproduction **against the real product**: commands, versions, and verbatim output. Reasoning alone is not enough. For a new capability, explain who needs it and in what situation. Also list related issues / PRs, or write "Searched, no duplicates" (see [Deduplicate](#deduplicate)).

### Root cause

Identify the relevant code or external dependency layer. Distinguish upstream changes, such as image registries or npm releases, from defects in this repository.

### Changes

Explain what changed and what was deliberately left out. Name key files rather than pasting a large diff.

### Verification evidence

- The current head SHA.
- A link to the CI run for that SHA, identifying the workflow and job. A green run from an older push does not count.
- Test names and passing counts, for example `8 files / 42 tests`. Include both local and CI results.
- For UI or visible behavior changes, embed screenshots or recordings in the PR. You can drag them into GitHub. If stable links are needed, publish them on an orphan `pr-assets` branch:

  ```bash
  git checkout --orphan pr-assets
  git rm -rf .
  mkdir -p pr-<number>
  # Include only png / webm files. No secrets or large, unedited recordings.
  git add pr-<number>
  git commit -m "pr-assets: <number>"
  git push -u origin pr-assets
  ```

  Use links of the form `https://raw.githubusercontent.com/openma-ai/<repo>/pr-assets/pr-<number>/<file>`. Store evidence only on `pr-assets`; do not develop there.

### Unverified areas

List checks that were not run and explain why. Distinguish author-written mocks, fixtures, and test doubles from real product or upstream behavior. Passing mocks do not establish that a KVM sandbox, hosted environment, or downstream repository has been verified.

### Risks and rollback

Describe the worst case and how to recover: revert the squash commit or release a fix. For releases and migrations, explain what users will experience.

### Example

This abbreviated report from #227 illustrates the format. Write a report specific to your change.

> **Problem / motivation.** `pnpm test:integration:storage` failed during global setup in CI run [36001613340](https://github.com/openma-ai/open-managed-agents/actions/runs/36001613340), before any tests started. The log showed `401 unauthorized` when pulling MinIO anonymously. On a clean machine, `docker pull quay.io/minio/minio@sha256:d249d1fb…` also returned 401.
>
> **Root cause.** Repository code had not changed. `quay.io/minio/minio` stopped allowing anonymous pulls.
>
> **Changes.** Switched the test image to the anonymously accessible `cgr.dev/chainguard/minio` and pinned its manifest digest.
>
> **Verification evidence.** Local `pnpm test:integration:storage`: 8 files / 42 tests passed. Before merge, the CI storage step passed for the PR head.
>
> **Unverified areas.** This is a CI MinIO image, not a product runtime dependency. No product code for S3 conditional writes changed, so no additional product-level manual S3 verification was performed.
>
> **Risks and rollback.** Affects only storage integration tests. Reverting the commit restores the previous image reference.

## CI must be green

Before merge, all required CI for the current PR head SHA must pass. When a check fails, read the logs and document the root cause before changing code or tests. Do not repeatedly rerun the same SHA until it happens to turn green.

A rerun may be used to collect another log. If the first run fails and the second passes, explain the difference in the report: a timeout, an external registry, or a run canceled by concurrency. Keep investigating if the cause is unknown. In #227, the registry's MinIO 401 was confirmed before replacing the image.

`concurrency.cancel-in-progress: true` cancels older running workflows for the same ref. A canceled run is not a flake; inspect the run for the new SHA.

## Dependency upgrades

Both Dependabot PRs and manual lockfile updates require compatibility checks. Green CI is only one part of verification:

- Read upstream changelogs and release notes and list behavior changes.
- Run the repository's existing compatibility matrix, not only default unit tests. In deepseek-harness-acp, the `dsh-compatibility` job installs multiple `@deepseek-ai/dsh` versions from `runtime/compatibility.json` and runs profile smoke tests. The scheduled `dsh-update.yml` workflow opens `chore: upgrade bundled dsh to <version>` PRs. #33 added a Cursor agent review; a human still owns the merge decision.
- Do not also version the package in an upgrade PR. Automated dsh PRs explicitly state: “This PR does not bump or release the ACP package.”
- Do not merge if compatibility cannot be restored.

After release, open separate downstream bump PRs that use the released version and run each downstream repository's own CI:

- Martty's `npm/package.json` depends on `@openma/deepseek-harness-acp`. Its changelog records upgrades to 0.4.29 and 0.4.31; #135 picked up the 0.4.35 packaging fix.
- After openma-common is tagged and published to npm, consuming repositories update `@openma/common` and commit their lockfiles, as described in that repository's contribution-guide release checklist.

## Sandbox provider adapters

### Anti-pattern: #353 OpenSandbox adapter

[#353](https://github.com/openma-ai/open-managed-agents/pull/353) is our own example of what not to do.

**What we did.** We hand-wrote a lifecycle / execd HTTP client, reimplementing the vendor protocol. Tests ran only against our own HTTP doubles, built from our interpretation of the documentation. After merging, we also published a blog post claiming OpenMA supported OpenSandbox.

**What failed against the real service.** External contributor @jwx0925 found these issues on a real server:

- Command streams contain blank-line-separated JSON records without a `data:` prefix. Our SSE parser dropped `execution_complete`.
- Uploads sent `metadata` as a plain text field, but the server required a multipart file part and returned HTTP 400 `INVALID_FILE_METADATA`. Restoring session outputs after a restart also uses uploads, so recovery failed too.

[#363](https://github.com/openma-ai/open-managed-agents/pull/363) patched the hand-written client and was closed. [#364](https://github.com/openma-ai/open-managed-agents/pull/364) replaced it with the official SDK.

**Rules:**

- Use the vendor's official SDK when one exists. Follow this repository's provider dependency boundaries (`scripts/provider-package-boundaries.test.mjs`): declare an optional peer dependency and load it lazily.
- Test doubles must come from traffic captured against the real service, or use the SDK itself. Do not build doubles solely from our interpretation of documentation.
- Before merge, run a live certification test against a real service. Keep it opt-in and disabled by default; see #364's `test:certification`. Record the service and version in the PR's verification evidence.
- Do not claim support in blogs, docs, or the README before live verification.

## Release

Follow the repository's actual workflow. The organization uses two approaches.

**Tags:** deepseek-harness-acp, Martty, and openma-common.

1. Set the version in manifests. Martty also requires the tag, `npm/package.json`, and `Cargo.toml` to agree (`scripts/check-release-tag.mjs`).
2. dsh and Martty release commits on `main` use `release: vX.Y.Z` (for example dsh `v0.4.36` and Martty `v0.3.0`). openma-common tags the matching version after its release PR merges.
3. Run `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag must point to the release commit on `main`.
4. The tag triggers publication. dsh's `release.yml` verifies that the tag is on `main`, runs tests, the dsh compatibility matrix, and standalone smoke tests, then publishes with npm OIDC. Martty's `package-npm.yml` listens for `v*.*.*`.
5. openma-common's `v*` tags are validated by `release-tag.yml`, which publishes `@openma/common` with npm OIDC. Update consumers afterward.

**Changesets:** used for `@openma/cli` and `@openma/sdk`; see [This repository](#this-repository-open-managed-agents). This repository's `version-pr` runs MySQL integration tests but has no `Enable KVM for Litebox` step; Litebox tests fail when `/dev/kvm` is unavailable.

Release commits contain only versions and changelogs. Features go through ordinary PRs first. After release, open downstream bump PRs as described above.

## Security

Report vulnerabilities privately, not in public issues. For this repository, follow [SECURITY.md](SECURITY.md) and use [private vulnerability reporting](https://github.com/openma-ai/open-managed-agents/security/advisories/new). When copying this guide, substitute the destination repository's private reporting channel.

Do not ship debug ports or secrets:

- Published Node processes, image `CMD`s, and installers must not enable `--inspect`, port `9229`, or Chrome's `--remote-debugging-port`.
- Images expose only product ports; do not add debug ports to `EXPOSE`.
- Never include `.env`, `.dev.vars`, tokens, or keystores in Git, npm packages, GHCR images, or desktop installers.

Handle dependency advisories in separate fixes (for example Backchat's `chore: prepare Backchat v0.0.9 security release`). Fixes still require ordinary PRs and evidence reports; advisory details stay private.

## This repository: open-managed-agents

`docs/github-pr-flow.md` describes how product agents attach GitHub repositories and open PRs; it is not this contribution guide. `apps/main-node/Dockerfile` exposes port `8787`.

Use the Node version in `.node-version` (24.18.0 in the source guide, with `engines.node` set to `24.x`) and the root `package.json`'s `packageManager` (then `pnpm@11.0.8`). Use Corepack and install with `--frozen-lockfile`, as CI does.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

| Command | Purpose |
|---|---|
| `pnpm dev` | Wrangler: API and agent worker, `http://localhost:8787` |
| `pnpm dev:console` | Console (Vite), `http://localhost:5173` |
| `pnpm dev:docs` | Documentation site, `http://localhost:4321` |
| `docker compose up -d` | Self-hosted Node deployment; prepare `.env` following the README first |

Before submitting, run `pnpm typecheck` and tests for the packages you changed. Run `pnpm test` for shared-path changes. `pnpm test` does not include the subsequent CI checks for Console agent editor E2E, protocol coverage, storage, or MySQL. E2E requires Playwright; storage and MySQL require Docker. CI also grants the runner access to `/dev/kvm` before MySQL tests, as described below.

The source guide records the following order for workflow `CI` (`.github/workflows/ci.yml`, PRs and `main`, job `verify`, then documented as `ubuntu-latest` with a 30-minute timeout). The workflow file is authoritative for current settings:

1. `pnpm typecheck`
2. `pnpm test`
3. Install Playwright Chromium, then run `pnpm test:e2e:agent-editor`.
4. `pnpm test:coverage:protocol`
5. `pnpm test:integration:storage` — Testcontainers and MinIO (Chainguard image, #227).
6. `Enable KVM for Litebox`
7. `pnpm test:integration:mysql` — Testcontainers `mysql:8.4` (`apps/main-node/vitest.mysql.config.ts`). The suites are `test/persistence.mysql.integration.ts` and `test/main-node.mysql.integration.ts`. On October 2, 2026, after #237 merged, [CI run 36998373962](https://github.com/openma-ai/open-managed-agents/actions/runs/36998373962) (head `0d5c5f00`) recorded **2 files / 16 tests** (6 + 10). #239 did not change `ci.yml` or those files. This is a historical result, not an automatically updated latest-run pointer.

**KVM.** The step's comments explain that ubuntu-24.04 runners have `/dev/kvm`, owned by `root:kvm` with mode `0660`, while the runner user is not in the `kvm` group. `Enable KVM for Litebox` runs before MySQL. If the device is missing, the job fails and MySQL does not run. The step writes a udev rule and runs `chmod 666 /dev/kvm`. It also fails if `chmod` fails or the current user does not end up with both read and write access.

In `pnpm test:integration:mysql`, the “runs official /v1/sessions on two real Node owners…” test in `apps/main-node/test/persistence.mysql.integration.ts` (#237) starts two real Node owners with `SANDBOX_PROVIDER=litebox`. On Linux it requires readable and writable `/dev/kvm`. The Litebox sandbox is real. The model is not an upstream LLM: the test uses `scripts/bootstrap-model-card.mjs` to create a workspace model card with key `fixture` and a `base_url` pointing to an SSE server started by the test process on `127.0.0.1`. It replays scripted `tool_use` and text responses. Both owners read the same card from shared MySQL; their process environments contain no model key. This is not Haven, a hosted environment, or boxrun (a separate machine running `boxlite serve`). Other tests in the same file use independent actor processes against MySQL and MinIO without starting microVMs. `main-node.mysql.integration.ts` sets `OPENMA_TEST_SANDBOX_PROVIDER=local-subprocess`, not Litebox.

Unit tests in `packages/sandbox-adapter-litebox` still use `vi.mock("@boxlite-ai/boxlite")` and do not open `/dev/kvm`. Passing them in `pnpm test` does not prove a microVM ran. See below for Release's `version-pr`.

| Workflow | Trigger | Jobs |
|---|---|---|
| `Build OpenMA Server Image` | PRs touching server-related paths; pushes to `main` touching the same paths; `openma-server-v*` tags; `workflow_dispatch` | `verify` (main-node / main-fly typechecks and tests, Console build), `build` (GHCR; PRs build without pushing; tags add version aliases) |
| `Build Sandbox Base Image` | Changes to `apps/agent/Dockerfile` on `main`, or manual dispatch | `build`, pushes to Docker Hub |
| `Release` | Pushes to `main` and `workflow_dispatch` only | `version-pr`, `publish`; `version-pr` runs MySQL integration without a KVM step, as described below |

The source guide records that `release.yml`'s `version-pr` runs `pnpm typecheck`, `pnpm test`, storage, and `pnpm test:integration:mysql` on `ubuntu-latest` without `Enable KVM for Litebox`. Without readable and writable `/dev/kvm`, the two-owner Litebox test fails. At the historical check after #237, the workflow had not completed end to end: [#237's run 36998373909](https://github.com/openma-ai/open-managed-agents/actions/runs/36998373909) was canceled before any job started; [#239's run 37004877345](https://github.com/openma-ai/open-managed-agents/actions/runs/37004877345) was still pending with no jobs when checked on October 2, 2026. These observations are historical, not a statement of current run status.

`@openma/cli` and `@openma/sdk` use changesets. See [docs/release-process.md](docs/release-process.md):

1. For user-visible changes to either package, run `pnpm changeset` in the feature PR and commit `.changeset/*.md`. Internal `@open-managed-agents/*` packages are not published to npm; do not add changesets for them. Published paths are `src/`, `README.md`, and runtime dependencies. Test-only or devDependency-only changes need no changeset. If uncertain, use `pnpm changeset --empty`.
2. CI's `release-check` runs alongside `verify` without installing dependencies. Missing changesets fail the check. Minor or major changesets or version bumps require `release:minor` or `release:major`; patches need no label. A Version Packages PR's changelog must also cover every merged PR since the previous `@openma/<name>@*` tag that changed the published paths above.
3. After merge, `release.yml`'s `version-pr` opens or updates a PR titled `chore: version packages`.
4. Review the versions and changelogs before merging. Before `pnpm release`, `publish` runs `node scripts/release-check.mjs --publish`; it does not change the bump or publication mechanism. Publication uses the GitHub Environment `production` and requires approval, then publishes with npm OIDC. Stable tags look like `@openma/cli@0.6.0`. For beta releases, run `pnpm changeset pre enter beta`; versions have `-beta.N` and the npm dist-tag is `beta`.
5. Manual release PRs have also been used: `chore: release stable CLI 0.6.0 and SDK 1.0.0` (#209) ran `changeset pre exit` after beta.2.

User documentation lives in `apps/docs`. Its Contributing page still uses the older What / Why / Test plan outline; this file and the GitHub PR template are authoritative.

Join [Discord](https://discord.gg/P3EfQFm5bD) for questions and discussion; English and Chinese are welcome. Report reproducible bugs in GitHub Issues.
