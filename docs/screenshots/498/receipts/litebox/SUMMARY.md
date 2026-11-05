# PR #498 — cloud Environment / CF Containers lane receipts

Lane: https://managed-agents-lane-pr-498.hrhrngxy.workers.dev  
Provider under test: **Cloudflare Containers** (lane default). **Not** Microsoft LiteBox — this lane has no LiteBox secrets or LiteBox provider wiring (`SANDBOX_PROVIDER=litebox` is Node-local only).

Folder name `litebox/` is historical (M1 “cloud Environment” evidence slot). Do not read it as LiteBox-provider proof.

Also see `README.md` and `SUMMARY.json` in this directory.

## Proven (2026-11-05, America/Detroit)

1. **Cloud Environment create** — `POST /v1/environments` with `config.type=cloud` → 201  
   - `env_aeb1c14c…` (`env-cloud-create.json`)  
   - Confirmatory r1: `env_cc51adc1…` (`env-cloud-create.r1.json`)

2. **CF Containers on the lane** — app `sandbox-default-lane-pr-498-sandbox` healthy  
   (`container-app.redacted.json` / `container-app.json`; image digest reused from staging because the box has no Docker).

3. **Live cloud Session turns** completed with agent reply **`CLOUD_SANDBOX_OK`**:
   - Primary (after MAIN_MCP bind fix): `session_910dff3d…` — `session-cloud3-final.json` + `session-cloud3-events.json`
   - Confirmatory r1: `session_bb142b6e…` — `session-final.r1.json` + `events-final.r1.json`

4. Lane fix notes (see `SUMMARY.json` / `README.md`): container app created via CF API without local Docker build; agent worker needed `MAIN_MCP` → `McpProxyRpc` for cloud warmup (pre-fix warmups failed with “Managed Session input source service binding is unavailable”).

## Blockers / limits (honest)

- Shared box (and Botty Mac) have **no Docker**. `wrangler deploy` without `--containers-rollout=none` fails (`redeploy-containers.log`). Evidence used an **already-uploaded** registry image; this does **not** prove a from-scratch container image build/rollout from this box.
- Microsoft **LiteBox was not configured** and was not exercised.
- Attach-Runtime + botty path evidence lives under `docs/screenshots/498/receipts/` (non-`litebox/`) and `receipts/botty/`.
- Residual: sdk/container `version_mismatch` warn 0.12.10 vs 0.12.9 on reused staging digest (non-fatal for these turns).
