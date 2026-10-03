#!/usr/bin/env bash
# Local/VPS installer. Credentials stay in .env.openma; existing installs are reused.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
umask 077
configure_only=0
for arg in "$@"; do
  case "$arg" in
    --configure-only) configure_only=1 ;;
    --help|-h)
      cat <<'HELP'
Usage: bash scripts/setup-docker.sh [--configure-only]

Choose SQLite or Postgres and an isolated sandbox provider interactively.
For unattended setup, set OPENMA_DOCKER_PROVIDER=e2b|daytona|boxrun and its
E2B_API_KEY, DAYTONA_API_KEY, or BOXRUN_URL (optionally BOXRUN_TOKEN).
Optional: OPENMA_DOCKER_DATA_MODE=sqlite|postgres, OPENMA_DOCKER_PORT=8787,
OPENMA_DOCKER_PUBLIC_URL=https://oma.example.com, OPENMA_DOCKER_BIND_HOST=0.0.0.0.
Defaults to localhost only. Set both public URL and bind host for a VPS.
--configure-only writes configuration without starting Docker or cloud resources.
Reruns reuse .env.openma without rotating secrets or replacing provider keys.
HELP
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
fail() { printf '%s\n' "$*" >&2; exit 1; }
ask() {
  local name="$1" label="$2" fallback="$3" secret="${4:-0}" value
  if [[ -t 0 ]]; then
    if [[ "$secret" == 1 ]]; then read -r -s -p "$label: " value; printf '\n' >&2;
    else read -r -p "$label [$fallback]: " value; fi
    printf -v "$name" '%s' "${value:-$fallback}"
  else printf -v "$name" '%s' "$fallback"; fi
}
# Never source an env file: values are data, not shell commands.
saved() { sed -n "s/^$1='\([^']*\)'$/\1/p" .env.openma; }
[[ ! -L .env.openma ]] || fail '.env.openma must not be a symlink.'
if [[ -e .env.openma ]]; then
  [[ -f .env.openma ]] || fail '.env.openma must be a regular file.'
  data_mode="$(saved OPENMA_DOCKER_DATA_MODE)"
  [[ "$data_mode" == sqlite || "$data_mode" == postgres ]] || fail 'Invalid saved storage mode in .env.openma.'
  [[ -z "${OPENMA_DOCKER_DATA_MODE:-}" || "$OPENMA_DOCKER_DATA_MODE" == "$data_mode" ]] || fail 'Storage mode differs from this installation. Migrate data explicitly before changing storage.'
  public_url="$(saved PUBLIC_BASE_URL)"
  printf 'Reusing .env.openma; existing application secrets and provider credentials are unchanged.\n'
else
  command -v openssl >/dev/null || fail 'Install openssl to generate application secrets.'
  data_mode="${OPENMA_DOCKER_DATA_MODE:-}"
  [[ -n "$data_mode" ]] || ask data_mode 'Storage: sqlite or postgres' sqlite
  [[ "$data_mode" == sqlite || "$data_mode" == postgres ]] || fail 'OPENMA_DOCKER_DATA_MODE must be sqlite or postgres.'
  provider="${OPENMA_DOCKER_PROVIDER:-}"
  [[ -n "$provider" ]] || ask provider 'Sandbox provider: e2b, daytona, boxrun' ''
  case "$provider" in
    e2b) credential_name=E2B_API_KEY ;;
    daytona) credential_name=DAYTONA_API_KEY ;;
    boxrun) credential_name=BOXRUN_URL ;;
    *) fail 'Choose OPENMA_DOCKER_PROVIDER=e2b, daytona, or boxrun (isolated providers only).' ;;
  esac
  credential="${!credential_name:-}"
  [[ -n "$credential" ]] || ask credential "$credential_name" '' 1
  [[ -n "$credential" ]] || fail "$credential_name is required."
  port="${OPENMA_DOCKER_PORT:-8787}"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || fail 'Port must be an integer from 1 to 65535.'
  port=$((10#$port))
  ((port > 0 && port <= 65535)) || fail 'Port must be an integer from 1 to 65535.'
  bind_host="${OPENMA_DOCKER_BIND_HOST:-127.0.0.1}"
  [[ "$bind_host" == 127.0.0.1 || "$bind_host" == 0.0.0.0 ]] || fail 'Bind host must be 127.0.0.1 or 0.0.0.0.'
  public_url="${OPENMA_DOCKER_PUBLIC_URL:-http://localhost:$port}"
  public_url="${public_url%/}"
  [[ "$public_url" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$ ]] || fail 'Public URL must be an HTTP(S) origin without a path or credentials.'
  if [[ "$bind_host" == 0.0.0.0 ]]; then
    [[ "$public_url" == https://* ]] || fail 'Set OPENMA_DOCKER_PUBLIC_URL to your HTTPS reverse-proxy origin before binding publicly.'
  fi
  # Single quotes prevent Docker Compose interpolation of $, #, and spaces.
  # Reject unsupported quoting and multiline values instead of corrupting secrets.
  for value in "$credential" "${BOXRUN_TOKEN:-}" "${E2B_API_URL:-}" "${DAYTONA_API_URL:-}"; do
    [[ "$value" != *"'"* && "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *'\'* ]] || fail 'Credentials and provider URLs must be single-line values without quotes or backslashes.'
  done
  auth_secret="$(openssl rand -hex 32)"
  root_secret="$(openssl rand -hex 32)"
  postgres_secret="$(openssl rand -hex 32)"
  temp="$(mktemp .env.openma.XXXXXX)"
  trap 'rm -f "$temp"' EXIT
  emit() { printf "%s='%s'\n" "$1" "$2"; }
  {
    emit OPENMA_DOCKER_DATA_MODE "$data_mode"
    emit OPENMA_BIND_HOST "$bind_host"
    emit OPENMA_PORT "$port"
    emit PUBLIC_BASE_URL "$public_url"
    emit GATEWAY_ORIGIN "$public_url"
    emit BETTER_AUTH_SECRET "$auth_secret"
    emit PLATFORM_ROOT_SECRET "$root_secret"
    emit SANDBOX_PROVIDER "$provider"
    emit "$credential_name" "$credential"
    if [[ "$provider" == boxrun && -n "${BOXRUN_TOKEN:-}" ]]; then emit BOXRUN_TOKEN "$BOXRUN_TOKEN"; fi
    if [[ "$provider" == e2b && -n "${E2B_API_URL:-}" ]]; then emit E2B_API_URL "$E2B_API_URL"; fi
    if [[ "$provider" == daytona && -n "${DAYTONA_API_URL:-}" ]]; then emit DAYTONA_API_URL "$DAYTONA_API_URL"; fi
    if [[ "$data_mode" == postgres ]]; then emit OPENMA_POSTGRES_PASSWORD "$postgres_secret"; fi
  } > "$temp"
  # Atomic, exclusive creation: concurrent setup cannot overwrite an install.
  ln "$temp" .env.openma || fail 'Another setup created .env.openma; rerun to reuse it.'
  rm -f "$temp"
  trap - EXIT
  unset credential
  printf 'Created private .env.openma configuration. Keep a backup of this file with your data.\n'
fi
if [[ "$configure_only" == 1 ]]; then
  printf 'Configuration ready. Run bash scripts/setup-docker.sh to build and start OpenMA.\n'
  exit 0
fi
command -v docker >/dev/null || fail 'Install Docker Engine/Desktop with Compose v2.24+.'
docker compose version >/dev/null || fail 'Docker Compose v2.24+ is required.'
docker info >/dev/null 2>&1 || fail 'Start Docker and rerun this command.'
compose=(docker compose --project-name openma-quickstart --env-file .env.openma -f compose.quickstart.yml)
[[ "$data_mode" != postgres ]] || compose+=(-f compose.quickstart.postgres.yml)
"${compose[@]}" config --quiet
printf 'Building OpenMA and waiting for its health check (the first build can take several minutes)...\n'
"${compose[@]}" up --build --wait --wait-timeout 180
printf '\nOpenMA is healthy. Open %s and create your account, then add a Model Card.\n' "$public_url"
printf 'Stop without deleting data: '
printf '%q ' "${compose[@]}" stop
printf '\n'
