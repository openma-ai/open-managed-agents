#!/usr/bin/env bash
# Official-SDK E2E against a deployed Managed Agents API.
# Usage: ./test/e2e/e2e.sh <BASE_URL> <API_KEY>
# Set OMA_E2E_RUN_TURN=1 to include a real agent turn and SSE verification.

set -euo pipefail

export OMA_E2E_BASE_URL="${1:?Usage: $0 <BASE_URL> <API_KEY>}"
export OMA_E2E_API_KEY="${2:?Usage: $0 <BASE_URL> <API_KEY>}"

exec node "$(dirname "$0")/managed-agents-sdk.mjs"
