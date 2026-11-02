# Dependency source policy

Production and development dependencies must resolve to published registry
packages, or to packages in this repository through `workspace:`. Do not commit
package tarballs or use `file:`, manual `link:`, Git, or arbitrary URL dependencies.
This applies to all four dependency sections and the pnpm lockfile.

Run `pnpm test:dependency-sources` to test the guard and
`pnpm check:dependency-sources` to inspect the checkout. The guard uses only Node
and Git, and CI plus the official server-image verification run it before
`pnpm install --frozen-lockfile`. Normal pnpm-generated workspace links are allowed.
A registry dependency that has not actually been published still fails the frozen
install; this static guard does not replace registry/install verification.

## Existing common tarball remediation

PR #399 introduced `apps/console/openma-common-0.13.1-dev.4.tgz`. The guard
intentionally rejects that existing violation: no grandfathering or CI bypass.
Do not merge this policy change alone while that dependency remains.

Before enabling this on main:

1. Fix and merge openma-common #60 and publish an approved stable version.
2. Verify the published package exports the Console's required APIs and includes
   the relevant QueueDock/ACP fixes (do not assume the development tarball and
   the PR head are identical).
3. Replace the Console dependency with the published range, remove the tracked
   tarball, and remove its dedicated COPY from `apps/main-node/Dockerfile`.
4. Regenerate `pnpm-lock.yaml` using the repository's pinned pnpm version.
5. Run the policy tests/check, frozen install, Console tests/build, server image
   verification and CI. Merge only when they pass.

The npm release, PR merge and deployment remain separate operator decisions.
