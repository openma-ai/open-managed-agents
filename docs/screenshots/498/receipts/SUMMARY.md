# PR 498 lane acceptance receipts (box)

Lane: https://managed-agents-lane-pr-498.hrhrngxy.workers.dev
Health: 200 {"status":"ok"}
Deploy: stub→full integrations/main/agent (--containers-rollout=none)
Secrets: lane-local API_KEY, PLATFORM_ROOT_SECRET, INTEGRATIONS_INTERNAL_SECRET, MCP_SIGNING_KEY, TURNSTILE always-pass.
BETTER_AUTH_SECRET: NOT set (staging value unavailable) — Console cookie login against lane blocked; API key used instead.

## Paths covered (API/CLI)
1. Mint pairing-tokens (201) with workspace API key
2. Anonymous mint → 401; bad TTL → 400
3. Exchange once → 200; replay → 400 "code already used"
4. Environments Attach self_hosted + overlay → 201
5. cloud+runtime → 400; bad env name → 400
6. Bundle overlay delivery when runtime matches; empty when detached/mismatched
7. Botty macOS CLI malformed token fail-fast; live bridge setup attempted

See JSON files in this directory (tokens redacted in committed copies).

8. **(A) Cloud Environment** `config.type=cloud` on CF lane → Cloudflare Containers (`receipts/cf-containers/`, formerly mislabeled `litebox/`) — LiteBox N/A on Workers
9. **(B) Local LiteBox env→VM** via Node `SANDBOX_PROVIDER=litebox` (`receipts/litebox-local/`) — guest `boxlite` / `init.krun` / `LITEBOX_LOCAL_OK`
10. **(C) Runtime placement=sandbox** — LiteBox-on-Runtime live allocate/isolation/skill-copy/resume (`receipts/runtime-placement-sandbox/live/`); ACP inference deferred
11. Pairing negatives: anonymous mint 401; bad TTL 400 (`pair-anon.json`, `pair-badttl.json`)
