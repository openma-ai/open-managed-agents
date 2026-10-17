#!/usr/bin/env bash
# Inject DeepSeek credentials for OMA live certification (issue #262).
# Reads DEEPSEEK_API_KEY from the environment only; never prints the key value.
set -euo pipefail

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "DEEPSEEK_API_KEY is not set in the environment" >&2
  exit 1
fi

DSH_DIR="${HOME}/.dsh"
CRED_FILE="${DSH_DIR}/.credentials.yaml"

umask 077
mkdir -p "${DSH_DIR}"
chmod 700 "${DSH_DIR}"

# YAML single-line value; key is never echoed to stdout/stderr.
printf 'DEEPSEEK_API_KEY: "%s"\n' "${DEEPSEEK_API_KEY}" > "${CRED_FILE}"
chmod 600 "${CRED_FILE}"

echo "Wrote ${CRED_FILE} (mode 600, DEEPSEEK_API_KEY only)"
