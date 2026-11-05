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
- [Environments → New → Cloud — provision a sandbox](acceptance/06-environments-new-cloud-provision.png)

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

## Unified skill cache (M1 implementation)

The host bridge now caches complete Skill Versions once and links OMA-managed
session directories to concrete immutable content. See
[skill-cache receipts](receipts/skill-cache/README.md) for live PR-lane reuse,
`latest`/pinned-version and no-hot-swap evidence. **These new receipts are Linux;
botty Mac sync/validation is blocked by unavailable remote execution access.**
Windows fallback is unit-tested; Runtime-owned sandbox cache mount/copy and
live-session-aware eviction remain deferred. Console UI is unchanged.

## Three lanes (do not conflate)

### (A) CF Containers — lane Hosting Type Cloud

LiteBox is **not** available on the CF Workers lane. Live Hosting Type **Cloud** on
`managed-agents-lane-pr-498` uses **Cloudflare Containers**:

- Receipts: [`receipts/cf-containers/`](receipts/cf-containers/) (renamed from the historical `receipts/litebox/` label)
- Environment `env_aeb1c14c…` · Session `session_910dff3d…` · provider `sandbox-default-lane-pr-498-sandbox`
- Confirmatory r1: `session_bb142b6e…` → `CLOUD_SANDBOX_OK`

### (B) Local LiteBox — Environment → microVM

Shared-box Node control plane with `SANDBOX_PROVIDER=litebox`
(`test/e2e/start-local-backend.sh`). Cloud Environment → Session runs in a
**BoxLite / libkrun** microVM (`boxlite-shim`):

- Receipts: [`receipts/litebox-local/`](receipts/litebox-local/)
- Environment `env_DdFqMZC4…` · Session `session_OlM-tOKE…` · guest hostname `boxlite` · agent reply `LITEBOX_LOCAL_OK`
- Guest `/proc/cmdline` includes `init=/init.krun` and `KRUN_INIT=…/boxlite-guest`

### (C) Runtime `placement=sandbox`

LiteBox-on-Runtime (daemon `RuntimeSandboxRegistry`), distinct from (B):

- Receipts: [`receipts/runtime-placement-sandbox/`](receipts/runtime-placement-sandbox/) (mocked + [`live/`](receipts/runtime-placement-sandbox/live/))
- Live: allocate / per-session isolation / skill `writeFileBytes` copy / same-registry resume on real `@boxlite-ai/boxlite`
- ACP inference on a prepared image and full paired-daemon Session turn remain deferred (see receipt README)
