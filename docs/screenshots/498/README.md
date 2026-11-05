# Runtime download + selection (#498)

Console acceptance screenshots for the M1 surfaces in
`docs/design/runtime-download-selection.md` §2 / §3c.

Captured locally with Playwright + intercepted API fixtures
(`apps/console/scripts/capture-498-acceptance.mjs`). They do not show
production data. Live Cloudflare lane API/CLI receipts for the same
paths are summarized in the PR comment and under `/tmp/oma-498-receipts/`
on the operator box.

## Screens

- [Runtimes list with online machine](acceptance/01-runtimes-list.png)
- [Connect machine modal (browser + headless)](acceptance/02-connect-machine-modal.png)
- [Generate pairing command](acceptance/03-generate-pairing-command.png)
- [Environments → New → Attach to existing Runtime + env overlay](acceptance/04-environments-new-attach-runtime.png)
- [Environment detail → Runtime card](acceptance/05-environment-detail-runtime-card.png)

## Live lane (operator)

- Lane URL: `https://managed-agents-lane-pr-498.hrhrngxy.workers.dev` (`/health` 200)
- Pairing mint / single-use replay, Environment overlay create, and
  authenticated bundle delivery (match / detach / mismatch) exercised
  against the lane with a workspace API key.
- Botty macOS CLI (`packages/cli` @ `b21bb3d6`) validates malformed
  `--token` fail-fast; headless `bridge setup --token` against the lane
  is covered in the PR comment / receipts.
