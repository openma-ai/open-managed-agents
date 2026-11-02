#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${RENDER_EXTERNAL_URL:-}}"
if [[ -z "$PUBLIC_BASE_URL" ]]; then
  echo 'Render public URL is missing; set PUBLIC_BASE_URL or RENDER_EXTERNAL_URL.' >&2
  exit 1
fi
PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"
if [[ ! "$PUBLIC_BASE_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo 'PUBLIC_BASE_URL must be an HTTPS origin without credentials or a path.' >&2
  exit 1
fi
export GATEWAY_ORIGIN="${GATEWAY_ORIGIN:-$PUBLIC_BASE_URL}"
exec pnpm start
