#!/usr/bin/env bash
# Start a throwaway main-node backend on :8787 for the local Console
# Playwright suites (console.spec.ts, console-deployments.spec.ts).
#
# Secrets are generated per run and never leave this process tree. The
# workspace API key is written to $OMA_E2E_STATE_DIR/api-key so callers can
# export OMA_E2E_LOCAL_API_KEY.
#
# Usage: OMA_E2E_STATE_DIR=/tmp/oma-e2e test/e2e/start-local-backend.sh
set -euo pipefail

node "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib/test-model-allowlist.mjs" --check-env
if [[ "${1:-}" == "--help" || "${1:-}" == "--check" ]]; then
  echo "Model overrides validated; omit --check to run the E2E scaffolding."
  exit 0
fi

STATE_DIR="${OMA_E2E_STATE_DIR:-$(mktemp -d)}"
PORT="${OMA_E2E_BACKEND_PORT:-8787}"
mkdir -p "$STATE_DIR"
if curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
  echo "port $PORT already serves a backend; stop it first" >&2
  exit 1
fi
API_KEY="oma-e2e-$(openssl rand -hex 16)"
printf '%s' "$API_KEY" > "$STATE_DIR/api-key"

env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL \
  HOST=127.0.0.1 \
  PORT="$PORT" \
  API_KEY="$API_KEY" \
  PLATFORM_ROOT_SECRET="$(openssl rand -base64 32)" \
  BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  DATABASE_PATH="$STATE_DIR/oma.db" \
  AUTH_DATABASE_PATH="$STATE_DIR/auth.db" \
  SANDBOX_WORKDIR="$STATE_DIR/sandboxes" \
  MEMORY_BLOB_DIR="$STATE_DIR/memory-blobs" \
  SESSION_OUTPUTS_DIR="$STATE_DIR/session-outputs" \
  FILES_BLOB_DIR="$STATE_DIR/files-blobs" \
  SANDBOX_PROVIDER=litebox \
  pnpm --filter @open-managed-agents/main-node start > "$STATE_DIR/main-node.log" 2>&1 &
echo $! > "$STATE_DIR/main-node.pid"

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "main-node ready on :$PORT (state: $STATE_DIR)"
    exit 0
  fi
  sleep 1
done
echo "main-node did not become healthy" >&2
tail -50 "$STATE_DIR/main-node.log" >&2
exit 1
