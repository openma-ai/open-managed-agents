# Local LiteBox — Environment → microVM (PR #498)

This folder is the **real LiteBox** evidence lane.

## What ran

| Item | Value |
|------|-------|
| Control plane | shared-box Node `main-node` via `test/e2e/start-local-backend.sh` |
| `SANDBOX_PROVIDER` | **`litebox`** (hardcoded in start script; process environ receipt) |
| Host | Linux box with `/dev/kvm` RW |
| Environment | `config.type=cloud` → `env_DdFqMZC4…` |
| Session | `session_OlM-tOKE…` (r2 after fixture stream fix) |
| Guest proof | `uname` → `Linux boxlite …`; `/proc/cmdline` → `init=/init.krun`, `KRUN_INIT=/boxlite/bin/boxlite-guest` |
| Agent reply | `LITEBOX_LOCAL_OK` |

## Proof artifacts

- `provider-banner.txt` / `provider-environ.redacted.txt` — `SANDBOX_PROVIDER=litebox`
- `startup-banner.txt` — main-node listening + script source line
- `env-cloud-create.json` / `agent-create.json` / `session-create.json` / `session-final.json`
- `events-final.json` — full turn including `agent.tool_use` (bash) + `agent.tool_result` + `agent.message`
- `vm-proof.txt` / `vm-proof.json` — extracted guest cmdline / marker
- `boxlite-runtime-snapshot.txt` — `boxlite-shim` + `libkrun VM` process tree; session workdir `.openma/litebox-scratch-*`
- `fixture-model-note.txt` — model was a local OpenAI-compatible fixture (deterministic `tool_use`); **sandbox is live LiteBox**, not mocked

## Not this folder

- Cloudflare Containers cloud evidence lives under [`../cf-containers/`](../cf-containers/) (formerly mislabeled `litebox/`).
- Runtime `placement=sandbox` remains design-only (see parent README).
