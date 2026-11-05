# LiteBox local env→VM — SUMMARY

- Date: 2026-11-05 America/Detroit
- Backend: `OMA_E2E_STATE_DIR=/tmp/oma-498-litebox-local` + `test/e2e/start-local-backend.sh`
- Provider: `SANDBOX_PROVIDER=litebox` → `@boxlite-ai/boxlite` → `boxlite-shim` / **libkrun** microVM
- Cloud Environment create: 201 `env_DdFqMZC4y8ZRohJlf3w6z`
- Session turn: `session_OlM-tOKEUoMmz0o9nWbIy` → idle with `agent.message` **`LITEBOX_LOCAL_OK`**
- Guest: hostname `boxlite`, kernel `Linux boxlite 6.12.76`, init `init.krun` / `boxlite-guest`
- Model: local fixture (OpenAI `/chat/completions` stream) for deterministic bash tool_use — not claimed as live DeepSeek
