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

## Common tarball remediation

PR #399 introduced `apps/console/openma-common-0.13.1-dev.4.tgz`.
`@openma/common@0.13.0` is now published after common #60 and release #61.
Console uses `^0.13.0`; the archive and Dockerfile's dedicated COPY are removed,
and the lockfile is regenerated with pnpm 11.0.8. The guard has no exceptions.

The published package additionally includes ACP permission-request input hold
changes beyond the old development tarball. Downstream Console tests/build and
server CI must pass before merge; publishing common does not verify a deployed
OMA browser session.

For future external changes: publish the upstream package first, then update the
manifest and lockfile and run the guard, frozen install and consumer tests.
Never bridge the release gap with a local package archive.
