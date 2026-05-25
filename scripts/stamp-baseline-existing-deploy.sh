#!/usr/bin/env bash
# scripts/stamp-baseline-existing-deploy.sh
#
# One-time migration for openma.dev's existing CF prod (and any other
# deployment that already has the historical 0001-0017 migration files
# applied via wrangler).
#
# What it does
# ────────────
# wrangler d1 migrations apply tracks applied filenames in each D1's
# `d1_migrations` table. Replacing the 20+ historical files with a single
# `0001_consolidated.sql` makes wrangler think the consolidated file is
# new — so it would try to re-apply on the next deploy and fail loudly
# (CREATE TABLE on existing tables, even with IF NOT EXISTS, can mess
# with state if any column shape changed mid-history).
#
# This script bypasses re-apply by INSERTing the new consolidated filename
# into d1_migrations as if wrangler had just applied it. The OLD historical
# rows stay — they're harmless, wrangler just no-ops files it's already seen.
#
# After running this once per environment, future deploys see:
#   - 0001_consolidated.sql       ← this script stamped it (skipped)
#   - 0001_schema.sql            ← old wrangler stamp (skipped)
#   - 0002_integrations_tenant_id.sql ← old wrangler stamp (skipped)
#   - ... etc
#   - <any new migration>         ← gets applied normally
#
# Usage
# ─────
#   ./scripts/stamp-baseline-existing-deploy.sh production
#   ./scripts/stamp-baseline-existing-deploy.sh staging
#
# A fresh self-hoster does NOT run this. They start with the consolidated
# file as their first apply — wrangler stamps it normally.

set -euo pipefail

ENV="${1:?Usage: $0 <production|staging>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "=== Stamping consolidated baselines on $ENV ==="

# Map env → DB names. Pull these from wrangler.jsonc env.<name>.d1_databases
# rather than hardcoding so a forked openma uses its own DB names.
read_db_names() {
  local config="$1"
  local env_key="$2"
  node -e "
    const {parse} = require('jsonc-parser');
    const fs = require('fs');
    const cfg = parse(fs.readFileSync('$config', 'utf8'));
    const dbs = cfg.env?.['$env_key']?.d1_databases ?? [];
    // Dedupe by database_name (AUTH_DB and AUTH_DB_00 alias the same DB).
    const seen = new Set();
    for (const d of dbs) {
      if (seen.has(d.database_name)) continue;
      seen.add(d.database_name);
      console.log(\`\${d.binding}\t\${d.database_name}\`);
    }
  "
}

# Stamp one filename in one D1's d1_migrations table.
stamp() {
  local db_name="$1"
  local filename="$2"
  echo "  $db_name :: $filename"
  npx wrangler d1 execute "$db_name" --remote \
    --command "INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES ('$filename', CURRENT_TIMESTAMP);" \
    > /dev/null 2>&1 || {
      echo "    (warn: failed — d1_migrations table may not exist yet on a never-deployed shard; safe to ignore)"
    }
}

# MAIN_DB / AUTH_DB shards (apps/main/migrations/, drizzle-emitted baseline)
echo
echo "MAIN_DB / AUTH_DB shards (consolidated: 0000_consolidated.sql):"
while IFS=$'\t' read -r binding db_name; do
  case "$binding" in
    MAIN_DB|AUTH_DB|AUTH_DB_*)  stamp "$db_name" "0000_consolidated.sql" ;;
    ROUTER_DB)
      stamp "$db_name" "0001_consolidated.sql"
      ;;
    INTEGRATIONS_DB)
      # Same logical baseline, different content — handled below from
      # apps/integrations/wrangler.jsonc
      ;;
  esac
done < <(read_db_names apps/main/wrangler.jsonc "$ENV")

echo
echo "INTEGRATIONS_DB (consolidated: 0001_consolidated.sql):"
while IFS=$'\t' read -r binding db_name; do
  if [ "$binding" = "INTEGRATIONS_DB" ]; then
    stamp "$db_name" "0001_consolidated.sql"
  fi
done < <(read_db_names apps/integrations/wrangler.jsonc "$ENV")

echo
echo "=== Done. ==="
echo "Verify on a sample DB:"
echo "  npx wrangler d1 migrations list <db-name> --remote --env $ENV"
echo "The consolidated baseline (0000_consolidated.sql for main shards,"
echo "0001_consolidated.sql for router + integrations) should appear alongside"
echo "the historical 0001-0017 rows; next deploy will skip all of them."
