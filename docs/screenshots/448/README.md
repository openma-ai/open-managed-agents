# Console Deployments UI (#448)

These are screenshots of the OMA Console, captured locally with Playwright and
intercepted API fixtures. They do not show production data or create resources.
The Claude Console reference images informed the information architecture and
behavior; these pages use OMA's existing components and styling.

- [List and filters](list.png)
- [Empty state](empty.png)
- [Create: manual](new-manual.png)
- [Create: schedule and next five runs](new-schedule.png)
- [Unsaved changes confirmation](unsaved.png)
- [Detail and runs](detail.png)
- [Detail in Simplified Chinese](detail-zh-CN.png)

## API mapping and differences from the reference

The UI uses the existing `/v1/deployments` and `/v1/deployment_runs` APIs.
Run, pause, resume (`unpause`), and archive use the backend's existing POST
routes. Run now is disabled for paused and archived deployments because the
backend only launches active deployments.

Created by uses the `created_by` metadata value recorded by the Console; other
clients' deployments may have no creator. Search and creator filtering run
locally, loading remaining deployment pages when needed. Agent and status
filters are sent to the backend. All excludes archived deployments, matching
the backend's default list behavior.

File resources select existing uploads; upload is available on the Files page.
GitHub repositories and memory stores support the options accepted by the
existing creation API. Schedule previews are advisory and use the browser's
timezone initially; saved deployment details use the server's upcoming runs.
Run records show launch errors or links to the sessions they started. The run
API exposes neither a run cost nor the current session execution status.

Local Runtimes retains its existing peer navigation entry.

## Verification

Export `COREPACK_HOME=$HOME/.corepack` before running pnpm.

- `pnpm --filter managed-agents-console typecheck`
- `pnpm --filter managed-agents-console test`
- `pnpm --filter managed-agents-console build`
- `pnpm dlx oxlint --deny-warnings <changed console source files>`
- `git diff --check`

There is no console lint script or repository lint configuration. Oxlint was
run explicitly: changed files have no warnings; scanning the entire console
also exits successfully, with existing warnings in unrelated files. The Vite
build reports its existing large-chunk advisory.
