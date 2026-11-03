# Release Process

OMA uses [changesets](https://github.com/changesets/changesets) to manage
versioning and publishing for the public npm packages:

- `@openma/cli` (`packages/cli`)
- `@openma/sdk` (`packages/sdk`)
- `@openma/core` (`packages/core`): domain models and Ports, types only
- `@openma/stores-memory` (`packages/stores-memory`): in-memory store adapters
- `@openma/stores-sql` (`packages/stores-sql`): SQL store adapters
- `@openma/server` (`packages/server`): control-plane composition and `nodeDefaults()`

`@openma/sdk` is a composition facade over `@anthropic-ai/sdk`: Managed Agents
calls use the official SDK unchanged, while product-only routes are exposed
under `client.oma`. It is released independently when that facade or the OMA
extension surface changes.

All `@open-managed-agents/*` internal packages are private and never
published — changesets is configured to skip them entirely.

The four control-plane packages follow
[ADR 0015](adr/0015-public-core-stores-server-packages.md). They are built by
`scripts/build-public-package.mjs`, which bundles the private packages they
use (listed as `devDependencies`) and fails the build if a published file or
runtime dependency list still names one. Any change to a Port or type in
`@openma/core` is a major release. Because `release-check` only sees a public
package's own `src/`, add a changeset by hand when you change a private
package that one of them bundles.

## TL;DR

```bash
# In the PR that introduces a user-visible change to cli or sdk:
pnpm changeset

# Pick the package(s), choose patch / minor / major, write a one-line
# changelog. Commits a .changeset/<random>.md file. Push it with the PR.
```

That's it for the feature PR. Releases no longer open or update
Version Packages on every `main` push — see below.

## How a release happens

Releases use a **frozen `release` branch** so heavy tests and the Version
Packages PR stay stable while `main` keeps merging. Later changesets on
`main` do **not** re-roll Version Packages mid-soak.

1. **You open a PR with code + a changeset.** `pnpm changeset` walks you
   through which package changed, what kind of bump (patch / minor /
   major), and a one-line summary. The summary lands in the changelog
   verbatim, so write it for users, not for reviewers.

2. **Reviewer merges the PR to `main`.** Pending `.changeset/*.md` files
   accumulate on `main`. Nothing opens a Version Packages PR yet.

3. **~Every 2 days (or `workflow_dispatch`), Release cuts `release`.**
   The workflow fast-forwards the `release` branch to current `main`,
   runs typecheck / unit / storage / MySQL tests on that tip, then opens
   (or updates) a **Version Packages** PR that **targets `release`**
   (not `main`) with:
   - Bumped versions in the affected `package.json`s
   - Updated `CHANGELOG.md`s containing every changeset summary since the
     last release, grouped by package
   - The `.changeset/*.md` files removed on the version branch (consumed)

   If a Version Packages PR is already open against `release`, the
   scheduled cut is skipped so an in-flight soak is not rewritten. Use
   `workflow_dispatch` with **force_cut** to abandon that soak and cut
   again from `main`.

4. **You review the Version Packages PR (user 「发」).** Sanity-check the
   version bumps and changelog. Merge into `release` when ready. Do not
   merge Version Packages into `main` directly.

5. **Merging Version Packages into `release` triggers publish.** The
   workflow sees no pending changesets on `release` and publishes the
   bumped packages to npm via OIDC trusted publisher (no NPM_TOKEN).
   dist-tag is auto-derived from the version: `0.x.y` → `latest`,
   `0.x.y-beta.N` → `beta`. A **GitHub Release** is created automatically
   with the changelog body.

6. **Sync `release` → `main`.** After a successful publish the workflow
   opens (or reuses) a `chore: sync release to main` PR so bumped
   versions and consumed changesets land on `main` before the next cut.
   Merge that sync PR when green.

### Hotfix (do not wait for the schedule)

1. Land the fix **and** its changeset on `main`.
2. Run **Actions → Release → Run workflow** (`workflow_dispatch`). Set
   **force_cut** only if an old Version Packages PR must be abandoned.
3. Wait for Version Packages to open/update against `release`.
4. User 「发」 — merge Version Packages into `release`; publish + sync
   proceed as above.

Alternatively, cherry-pick the fix onto the existing `release` branch
(keep the freeze), then re-run the version path carefully — prefer a
fresh cut via dispatch unless you know you need the same soak tip.

## Bump types

- `patch` — bug fix, no API change. `0.3.1 → 0.3.2`
- `minor` — backwards-compatible feature. `0.3.1 → 0.4.0`
- `major` — breaking change. `0.3.1 → 1.0.0`
- For `0.x.y` versions, semver allows breaking changes in `minor` bumps,
  but pick the most informative one. We're past the point where we can
  break the CLI without warning anyone.

## Release check

`scripts/release-check.mjs` is the changesets form of the release gate used
in openma-common and pi-acp. It does not bump versions, publish, or create
tags. CI runs it as the `release-check` job, in parallel with `verify`,
with no `pnpm install`.

On every pull request it prints a non-blocking notice listing pull requests
already merged to the base branch, since each package's previous
`@openma/<name>@*` tag, that changed files shipped by that package (`src/`,
`README.md`, or runtime dependency fields). Test files and devDependency
bumps are not listed and do not need a changeset.

It fails the pull request when:

- Those shipped files change and the PR adds neither a changeset for the
  package nor an empty changeset (`pnpm changeset --empty`).
- A changeset, or the resulting `package.json` bump, is `minor` or `major`
  and the PR does not have the `release:minor` or `release:major` label.
  A patch bump, and a prerelease increment that does not change
  major.minor.patch, needs no label. Promoting `x.y.z-beta.N` to a stable
  version uses the bump from the previous stable tag (or from `0.0.0` when
  the package has no stable tag yet).
- The PR changes a published version and `CHANGELOG.md` does not cover every
  such pull request since the previous tag. Coverage is a `(#N)` mention or
  the commit sha recorded by `@changesets/changelog-git`, or the changeset
  file being consumed into that changelog. `#100` does not count as `#10`.
- The new version's changelog heading is missing, or `.changeset/pre.json`
  disagrees with the dist-tag changesets will publish (`latest` when not in
  pre mode, otherwise the `pre.json` tag, which must match the version's
  prerelease id).

Package READMEs in this repo do not pin a version, and `dist/` is built at
publish time and gitignored, so those openma-common checks are not repeated.
The tag changesets will create is `@openma/<name>@<version>`.

The `publish` job in `release.yml` runs `node scripts/release-check.mjs
--publish` before `pnpm release` on the `release` branch. On a push that
is not publishing a new version it only prints the unreleased notices and
exits 0. `version-pr` runs only after a scheduled/manual cut, not on every
`main` push.

`node scripts/release-check.mjs --audit` prints the same checks against
existing tags and lists CHANGELOG versions that have no git tag. It exits 0.
`--registry` also compares npm dist-tags. The history test
`scripts/release-check.history.test.mjs` needs a full clone with tags; the
`release-check` job fetches them. `pnpm test` runs the fixture tests only.

## Beta / prerelease workflow

To start a beta cycle for the next release:

```bash
pnpm changeset pre enter beta
git add .changeset/pre.json
git commit -m "enter beta prerelease mode"
git push
```

While in beta mode, every Version Packages PR produces `0.x.y-beta.N`
versions, and publishes to `--tag beta` automatically. Users on the
default `latest` tag are unaffected.

To exit beta and ship the stable version:

```bash
pnpm changeset pre exit
git add .changeset/pre.json
git commit -m "exit beta prerelease mode"
git push
```

The next Version Packages PR will roll the accumulated changesets into a
single stable bump and publish to `latest`.

## What if my PR doesn't change a published package?

Don't add a changeset. Most PRs touch internal packages, console UI,
docs, or workers — none of those publish to npm. The release workflow
ignores PRs without a changeset.

If you're not sure, run `pnpm changeset --empty` to add a marker that
explicitly says "no version bump needed" (useful for changesets bot
checks).

## Trusted publisher setup

`release.yml` publishes via npm's OIDC trusted publisher. Each public
package needs the workflow registered on npmjs.com:

1. Go to https://www.npmjs.com/package/@openma/cli/access
2. Trusted Publishers → Add publisher → GitHub Actions
3. Owner: `openma-ai`, repo: `open-managed-agents`
4. Workflow filename: `release.yml`
5. Environment: `production`

If the trusted publisher isn't configured, publish step 401s with
"audience mismatch" — recover by adding it.

**One workflow per package limit.** npm's trusted publisher only allows
one workflow per package, so we can't keep the old `publish-cli.yml` /
`publish-sdk.yml` as standalone escape hatches — they'd 401. The
`workflow_dispatch` trigger on `release.yml` cuts/fast-forwards `release`
from `main` and runs Version Packages (hotfix path). To re-attempt
**publish** only after a config fix, push an empty commit to `release`
(or re-run the failed `publish` job) while that branch has no pending
changesets and already carries the bumped versions.

## Troubleshooting

**My changeset PR didn't open a Version Packages PR.**
That is expected on merge to `main`. Version Packages only opens after
the scheduled cut (~every 2 days) or a manual **Release**
`workflow_dispatch`. Check `.changeset/` on `main` for pending `*.md`
files (other than `README.md`), then look at the latest "Release"
workflow run. If a Version Packages PR is already open, the schedule
skips until you merge it or `force_cut`.

**The Version Packages PR shows the wrong bump.**
Edit the `.changeset/*.md` file on `main` (via the source PR or a
follow-up), then `workflow_dispatch` Release with **force_cut** so a new
freeze picks up the fix. Do not expect mid-soak re-rolls from `main`
pushes — that is intentional.

**Version Packages keeps targeting `main` / updates on every merge.**
You are on the old flow. After this workflow change it must target
`release` only. Close any stale `changeset-release/main` PR.

**I want to publish out-of-band right now.**
Land a changeset (+ fix) on `main`, run **Release** via
`workflow_dispatch`, merge Version Packages into `release` (user 「发」),
then merge the sync PR `release` → `main`. You still need a changeset —
publish only fires when `release` has bumped `package.json` versions and
no pending changesets.

**I accidentally bumped to a version I shouldn't have.**
npm doesn't let you republish or downgrade. Bump again to a higher
version with the right content. Use `npm deprecate` if a published
version was actively harmful.

**I need to re-point a dist-tag (e.g. roll back `latest` to an older
version).**
This isn't supported via OIDC — you'll need to `npm login` locally and
run `npm dist-tag add @openma/cli@<version> latest`. Use sparingly; the
right answer for "this version is bad" is usually publish a new version
that fixes it, not move the tag.
