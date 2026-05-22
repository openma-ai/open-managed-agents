#!/usr/bin/env bash
# Webhook delivery e2e — fires correctly-signed Linear / GitHub / Slack
# webhooks at an OMA integrations gateway, verifies HTTP acceptance.
#
# Prerequisites:
#   - A live integrations gateway URL (e.g. https://integrations.staging.openma.dev)
#   - A `publicationId` row + its raw signing/webhook secret (read from the
#     wizard's "verify credentials" toast or the model_cards / publications
#     API after install)
#
# Usage:
#   ./test/e2e/e2e-webhooks.sh <gateway-url> <provider> <pubId> <secret>
# Provider: slack | github | linear
#
# Exits non-zero if any HTTP returns non-2xx.

set -euo pipefail

GATEWAY="${1:?gateway url}"
PROVIDER="${2:?provider (slack|github|linear)}"
PUB_ID="${3:?publication id}"
SECRET="${4:?webhook/signing secret}"

PASS=0; FAIL=0
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

run() {
  local label="$1"; shift
  echo "=== $label ==="
  if pnpm exec tsx "$ROOT/test/mocks/fire-webhook.ts" "$@"; then
    echo "✓ $label"
    PASS=$((PASS+1))
  else
    echo "✗ $label"
    FAIL=$((FAIL+1))
  fi
  echo
}

case "$PROVIDER" in
  slack)
    run "slack: app_mention" slack "$GATEWAY" "$PUB_ID" "$SECRET" "<@U_MOCK_BOT> hi"
    ;;
  github)
    run "github: labeled (engagement trigger)" github-labeled "$GATEWAY" "$PUB_ID" "$SECRET" 1 "oma:engage"
    run "github: issue_comment (wake-on-comment)" github-comment "$GATEWAY" "$PUB_ID" "$SECRET" 1 "follow-up"
    ;;
  linear)
    run "linear: IssueMention" linear-mention "$GATEWAY" "$PUB_ID" "$SECRET" "Webhook smoke test"
    run "linear: IssueAssignedToYou" linear-assigned "$GATEWAY" "$PUB_ID" "$SECRET" "Assigned smoke test"
    ;;
  *)
    echo "unknown provider: $PROVIDER"
    exit 2
    ;;
esac

echo "═══════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
