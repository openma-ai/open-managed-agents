#!/usr/bin/env bash
# Cloudflare self-host setup. Provisions remote resources and deploys public Workers.
# Requires pnpm install, Wrangler login, jq, openssl, and Docker for agent builds.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
DO_DEPLOY=1
SKIP_SECRETS=0
RESET_SECRETS=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --no-deploy) DO_DEPLOY=0 ;;
    --skip-secrets) SKIP_SECRETS=1 ;;
    --reset-secrets) RESET_SECRETS=1 ;;
    --help|-h)
      printf '%s\n' 'Usage: pnpm setup:cloudflare [--yes] [--no-deploy] [--skip-secrets] [--reset-secrets]' \
        '--yes: non-interactive provisioning/deployment; configure workspace Model Cards in Console after login; model keys are never uploaded.' \
        '--no-deploy: still creates remote resources, patches local configs, applies migrations and sets secrets. NOT a dry-run.' \
        '--skip-secrets: operator takes responsibility for all required Worker secrets.' \
        '--reset-secrets: DANGER: replaces encryption/auth secrets; existing encrypted data may become unreadable. Requires separate interactive confirmation; --yes cannot authorize it.'         'CLOUDFLARE_ACCOUNT_ID is required when more than one account is available.'
      exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done
say() { printf '\n▶ %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
die() { printf '  ✖ %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. Install it and try again."; }
if [ "$RESET_SECRETS" = 1 ]; then
  echo 'DANGER: replacing PLATFORM_ROOT_SECRET can make existing vault/model credentials impossible to decrypt; auth sessions/API keys will also change.' >&2
  [ "$YES" = 0 ] && [ -t 0 ] || die '--reset-secrets requires a separate interactive confirmation, not --yes.'
  [ "$SKIP_SECRETS" = 0 ] || die '--reset-secrets conflicts with --skip-secrets.'
  read -r -p 'Type RESET ENCRYPTION ROOT to continue: ' confirmation
  [ "$confirmation" = 'RESET ENCRYPTION ROOT' ] || die 'Reset cancelled.'
fi
if [ "$YES" = 0 ]; then
  [ -t 0 ] || die 'No interactive terminal. Use --yes to authorize remote provisioning/deployment (not a dry-run).'
  read -r -p 'Create/reuse remote resources, run migrations, and deploy public Workers? [y/N] ' confirmation
  case "$confirmation" in y|Y|yes) ;; *) die 'Setup cancelled.' ;; esac

fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo 'ANTHROPIC_API_KEY is not uploaded by setup and does not create a workspace Model Card.'; fi
say '0. Preflight'
for command in node npx pnpm jq openssl; do require_cmd "$command"; done
[ -d node_modules ] || die 'Missing installed dependencies. Run pnpm install first.'
node -e "require('jsonc-parser'); require.resolve('wrangler/package.json')" >/dev/null 2>&1 || die 'Missing installed dependencies. Run pnpm install first.'
if [ "$DO_DEPLOY" = 1 ]; then
  require_cmd docker
  docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable; start Docker before deploying the agent container.'
fi
wrangler() { CI=true npx --no-install wrangler "$@"; }
WHOAMI=$(wrangler whoami 2>&1) || die "Wrangler authentication failed. Run npx wrangler login. $WHOAMI"
# Do not select an arbitrary first account from a multi-account login.
ACCOUNTS=$(printf '%s\n' "$WHOAMI" | grep -oE '[a-f0-9]{32}' | sort -u || true)
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  [[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[a-f0-9]{32}$ ]] || die 'Invalid CLOUDFLARE_ACCOUNT_ID.'
  ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
else
  [ "$(printf '%s\n' "$ACCOUNTS" | grep -c .)" = 1 ] || die 'Missing or multiple Cloudflare accounts. Set CLOUDFLARE_ACCOUNT_ID explicitly.'
  ACCOUNT_ID="$ACCOUNTS"
fi
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
ok "Cloudflare account → $ACCOUNT_ID"
CONFIGS=(apps/main/wrangler.jsonc apps/agent/wrangler.jsonc apps/integrations/wrangler.jsonc)
# Parse and edit actual JSONC, retaining comments and environment overlays.
patch_jsonc() {
  node - "$1" "$2" "$3" <<'NODE'
const fs = require('fs');
const {modify, applyEdits} = require('jsonc-parser');
const [file, path, value] = process.argv.slice(2);
fs.writeFileSync(file, applyEdits(fs.readFileSync(file,'utf8'), modify(fs.readFileSync(file,'utf8'), JSON.parse(path), JSON.parse(value), {formattingOptions:{tabSize:2,insertSpaces:true}})));
NODE
}
patch_binding() {
  local idx
  idx=$(node - "$1" "$2" "$3" <<'NODE'
const fs=require('fs'); const {parse}=require('jsonc-parser');
const [file, array, binding]=process.argv.slice(2);
const entries=parse(fs.readFileSync(file,'utf8'))[array] || [];
const indexes=entries.flatMap((x,i)=>x.binding===binding?[i]:[]);
if(indexes.length!==1) { console.error('Expected exactly one '+binding+' in '+file); process.exit(1); }
console.log(indexes[0]);
NODE
  ) || return 1
  patch_jsonc "$1" "[\"$2\",$idx,\"$4\"]" "\"$5\""
}
patch_var() { patch_jsonc "$1" "[\"vars\",\"$2\"]" "\"$3\""; }
SECRET_LISTS=()
MISSING_WORKERS=()
# A failed list is NOT proof of an empty secret set. Only Wrangler's explicit
# worker-not-found diagnostic may initialize a fresh worker (verified in CLI source).
if [ "$SKIP_SECRETS" = 0 ] || [ "$DO_DEPLOY" = 1 ]; then
  for i in 0 1 2; do
    cfg="${CONFIGS[$i]}"
    if listing=$(wrangler secret list --config "$cfg" 2>&1); then
      printf '%s' "$listing" | jq -e 'type == "array" and all(.[]; .name | type == "string")' >/dev/null || die "Invalid secret list for $cfg"
      SECRET_LISTS[$i]="$listing"
      MISSING_WORKERS[$i]=0
      if [ "$DO_DEPLOY" = 1 ]; then
        worker_name=$(node -e "console.log(require('jsonc-parser').parse(require('fs').readFileSync(process.argv[1],'utf8')).name)" "$cfg")
        if status=$(wrangler deployments status --config "$cfg" --json 2>&1); then
          :
        elif [[ "$status" == *"The Worker $worker_name has no deployments."* ]]; then
          MISSING_WORKERS[$i]=1
        else
          die "Cannot inspect deployment status for $cfg; refusing bootstrap: $status"
        fi
      fi
    elif [[ "$listing" == *'If this is a new Worker, run `wrangler deploy` first to create it.'* ]] && [[ "$listing" == *'not found.'* ]]; then
      SECRET_LISTS[$i]='[]'
      MISSING_WORKERS[$i]=1
    else
      die "secret list failed for $cfg; refusing to overwrite secrets: $listing"
    fi
  done
fi
has_secret() { printf '%s' "${SECRET_LISTS[$1]}" | jq -e --arg name "$2" 'any(.[]; .name == $name)' >/dev/null; }
# Plan shared values before ANY writes. Existing values cannot be read back.
if [ "$SKIP_SECRETS" = 0 ]; then
  for name in PLATFORM_ROOT_SECRET INTEGRATIONS_INTERNAL_SECRET; do
    count=0
    for i in 0 1 2; do if has_secret "$i" "$name"; then count=$((count+1)); fi; done
    if [ "$RESET_SECRETS" = 0 ] && [ "$count" -gt 0 ] && [ "$count" -lt 3 ] && [ -z "${!name:-}" ]; then
      die "$name is partially configured; existing values cannot be read back. Export the SAME original value to fill missing copies, or recover it from your secret manager. Do not rotate the encryption root to repair a partial setup."
    fi
  done
  for name in PLATFORM_ROOT_SECRET INTEGRATIONS_INTERNAL_SECRET BETTER_AUTH_SECRET API_KEY; do
    if [ -z "${!name:-}" ]; then printf -v "$name" '%s' "$(openssl rand -hex 32)"; fi
  done
fi
say '1. Provision Cloudflare resources'
unique_id() {
  local ids="$1" label="$2"
  [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ] || die "Missing or ambiguous/multiple $label resources; select/rename resources manually."
  printf '%s\n' "$ids"
}
create_d1() {
  local out ids
  if out=$(wrangler d1 create "$1" --update-config=false 2>&1); then
    ids=$(printf '%s\n' "$out" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | sort -u || true)
  else
    ids=$(wrangler d1 list --json | jq -r --arg n "$1" '.[] | select(.name == $n) | .uuid') || return 1
  fi
  unique_id "$ids" "D1 $1"
}
create_kv() {
  local out ids
  if out=$(wrangler kv namespace create CONFIG_KV --update-config=false 2>&1); then
    ids=$(printf '%s\n' "$out" | grep -oE '"id"[[:space:]]*:[[:space:]]*"[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}' | sort -u || true)
  else
    # namespace list already emits JSON; it has no --json option.
    ids=$(wrangler kv namespace list | jq -r '.[] | select(.title == "CONFIG_KV") | .id') || return 1
  fi
  unique_id "$ids" 'KV CONFIG_KV'
}
AUTH_DB_ID=$(create_d1 openma-auth)
INTEGRATIONS_DB_ID=$(create_d1 openma-integrations)
CONFIG_KV_ID=$(create_kv)
for bucket in managed-agents-files managed-agents-workspace managed-agents-memory managed-agents-backups; do
  wrangler r2 bucket create "$bucket" || wrangler r2 bucket info "$bucket" || die "Cannot create/reuse R2 bucket $bucket"
done
# queues list has --page but no JSON option in this Wrangler version.
# Parse its table, page to exhaustion, and reject duplicate exact-name matches.
QUEUE_NAMES=''
page=1
while :; do
  listing=$(wrangler queues list --page "$page" 2>&1) || die "Queue query failed: $listing"
  rows=$(printf '%s
' "$listing" | node -e '
    let text=""; process.stdin.on("data",c=>text+=c).on("end",()=>{
      text=text.replace(/\x1b\[[0-9;]*m/g, "");
      for(const line of text.split("\n")) {
        const trimmed=line.trim();
        if(!trimmed || /^[┌┬┐├┼┤└┴┘─]+$/.test(trimmed) || /^⛅.*wrangler/.test(trimmed) || /^[-─]+$/.test(trimmed)) continue;
        // Wrangler prints this metadata for a non-default auth profile.
        if(/^Active profile: [a-zA-Z0-9_-]+$/.test(trimmed)) continue;
        const cells=line.split("│").map(x=>x.trim());
        if(cells.length>=4 && cells[1]==="id" && cells[2]==="name") continue;
        if(cells.length>=4 && /^[a-f0-9]{32}$/.test(cells[1]) && /^[a-zA-Z0-9_-]+$/.test(cells[2])) { console.log(cells[2]); continue; }
        console.error("Unrecognized Queue list output; refusing resource selection."); process.exit(1);
      }
    });') || die 'Cannot parse Queue query output safely.'
  [ -n "$rows" ] || break
  QUEUE_NAMES="$QUEUE_NAMES
$rows"
  page=$((page+1))
done
for queue in managed-agents-memory-events managed-agents-memory-events-dlq; do
  count=$(printf '%s\n' "$QUEUE_NAMES" | awk -v name="$queue" '$0 == name { n++ } END { print n+0 }')
  [ "$count" -le 1 ] || die "Ambiguous/multiple queue resources named $queue."
  if [ "$count" = 0 ]; then wrangler queues create "$queue" || die "Queue creation failed: $queue"; fi
done
say '2. Patch top-level self-host bindings'
for cfg in "${CONFIGS[@]}"; do patch_binding "$cfg" d1_databases MAIN_DB database_id "$AUTH_DB_ID"; done
for cfg in apps/main/wrangler.jsonc apps/integrations/wrangler.jsonc; do patch_binding "$cfg" d1_databases INTEGRATIONS_DB database_id "$INTEGRATIONS_DB_ID"; done
for cfg in apps/main/wrangler.jsonc apps/agent/wrangler.jsonc; do patch_binding "$cfg" kv_namespaces CONFIG_KV id "$CONFIG_KV_ID"; done
patch_var apps/agent/wrangler.jsonc CLOUDFLARE_ACCOUNT_ID "$ACCOUNT_ID"
say '3. Apply remote D1 migrations'
wrangler d1 migrations apply MAIN_DB --remote --config apps/main/wrangler.jsonc
wrangler d1 migrations apply INTEGRATIONS_DB --remote --config apps/integrations/wrangler.jsonc
if [ "$SKIP_SECRETS" = 0 ]; then
  say '4. Set missing secrets (preserve existing values)'
  set_secret() {
    local i="$1" name="$2" value="$3"
    if [ "$RESET_SECRETS" = 0 ] && has_secret "$i" "$name"; then ok "$name already set in ${CONFIGS[$i]} (preserved)"; return; fi
    printf '%s' "$value" | wrangler secret put "$name" --config "${CONFIGS[$i]}"
  }
  for i in 0 1 2; do
    set_secret "$i" PLATFORM_ROOT_SECRET "$PLATFORM_ROOT_SECRET"
    set_secret "$i" INTEGRATIONS_INTERNAL_SECRET "$INTEGRATIONS_INTERNAL_SECRET"
  done
  set_secret 0 BETTER_AUTH_SECRET "$BETTER_AUTH_SECRET"
  set_secret 0 API_KEY "$API_KEY"
fi
TEMP_CONFIGS=()
cleanup() { if [ "${#TEMP_CONFIGS[@]}" -gt 0 ]; then rm -f "${TEMP_CONFIGS[@]}"; fi; }
trap cleanup EXIT
if [ "$DO_DEPLOY" = 1 ]; then
  say '5. Build Console and deploy Workers'
  pnpm build:console
  deploy_worker() {
    local receipt urls
    if ! receipt=$(wrangler deploy --config "$1" 2>&1); then printf '%s\n' "$receipt" >&2; return 1; fi
    printf '%s\n' "$receipt" >&2
    urls=$(printf '%s\n' "$receipt" | grep -oE 'https://[a-zA-Z0-9.-]+.workers.dev' | sort -u || true)
    unique_id "$urls" 'deployment URL (workers.dev must be enabled)'
  }
  # Temporary configs live beside their originals so relative entrypoints,
  # migrations, assets and Dockerfile paths retain their meaning. Do not strip
  # live bindings on reruns. Main exports RuntimeRoom/McpProxyRpc before agent.
  bootstrap() {
    local temp
    temp=$(mktemp "apps/$1/.wrangler.setup.XXXXXX")
    TEMP_CONFIGS+=("$temp" "$temp.jsonc")
    mv "$temp" "$temp.jsonc"
    temp="$temp.jsonc"
    cp "apps/$1/wrangler.jsonc" "$temp"
    patch_jsonc "$temp" '["services"]' '[]'
    if [ "$1" = integrations ]; then patch_jsonc "$temp" '["triggers"]' '{"crons":[]}'; fi
    BOOTSTRAP_URL=$(deploy_worker "$temp")
  }
  # Recover an interrupted integrations bootstrap without replacing its live
  # config with another stripped bootstrap. Establish main's exports first.
  if [ "${MISSING_WORKERS[2]}" = 0 ] && [ "${MISSING_WORKERS[0]}" = 1 ]; then
    bootstrap main
    MISSING_WORKERS[0]=0
  fi
  if [ "${MISSING_WORKERS[2]}" = 1 ]; then bootstrap integrations; INTEGRATIONS_URL="$BOOTSTRAP_URL"; else INTEGRATIONS_URL=$(deploy_worker apps/integrations/wrangler.jsonc); fi
  patch_var apps/main/wrangler.jsonc INTEGRATIONS_ORIGIN "$INTEGRATIONS_URL"
  patch_var apps/integrations/wrangler.jsonc GATEWAY_ORIGIN "$INTEGRATIONS_URL"
  if [ "${MISSING_WORKERS[0]}" = 1 ]; then bootstrap main; fi
  deploy_worker apps/agent/wrangler.jsonc >/dev/null
  MAIN_URL=$(deploy_worker apps/main/wrangler.jsonc)
  deploy_worker apps/integrations/wrangler.jsonc >/dev/null
  say '6. Wire R2 memory notifications'
  wrangler r2 bucket notification create managed-agents-memory --event-type object-create object-delete --queue managed-agents-memory-events
  say 'Done. Deployment commands succeeded.'
  printf 'Console: %s
' "$MAIN_URL"
  echo 'Workspace model is not configured by setup. Register/login → your own workspace → Console Model Card → select it on an agent → first real task.'
  echo 'Not yet verified: /health, signup/login, and a real model task. Open Console, sign up, configure a Model Card (e.g. your compatible provider), select it on an agent, and run a first task.'
else
  say 'Provisioning complete; Workers were NOT deployed.'
  echo 'Origins and R2 notifications require deployment. Run setup again without --no-deploy to build/deploy and capture actual URLs.'
fi
