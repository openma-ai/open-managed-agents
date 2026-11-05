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
- Botty macOS live pair completed: runtime `1725d28a…` hostname `botty` **online**;
  receipts under `receipts/botty/` (status probe + daemon `_attach` via mihomo proxy).


## Botty Mac live pair (lane pr-498)

Live evidence from host `botty` (darwin/arm64) against
`https://managed-agents-lane-pr-498.hrhrngxy.workers.dev`:

| Item | Value |
|------|-------|
| runtime_id | `1725d28a-83d1-4434-9178-4b9a9ab93006` |
| machine_id | `3a081f41-9885-40ea-a433-39497f3b708e` |
| status | **online** (WS `_attach` + heartbeat) |
| egress | mihomo HTTP proxy `127.0.0.1:7890` (DNS poison workaround + undici/`HttpsProxyAgent`) |

Receipts: `receipts/botty/` (`bridge-status.txt`, `daemon-fg.log`, `exchange-redacted.json`, `runtimes-after-pair.json`).

Console fixtures `acceptance/01–05.png` were re-captured with the live `botty` hostname/runtime id so UI shots match the Mac connect path.
