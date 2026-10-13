#!/usr/bin/env bash
# test/e2e/run.sh — thin wrapper around the node e2e runner (test/e2e/run.mjs). Kept for `npm run e2e`.
#
#   bash test/e2e/run.sh                      # every case
#   bash test/e2e/run.sh --filter core        # cases tagged core
#   bash test/e2e/run.sh --list               # names, tags, cost caps
#   bash test/e2e/run.sh --case singular-load # cases whose name/file contains the text
#
# Env: E2E_MAX_COST_USD (global cap, default 3), SINGULAR_E2E_MODEL (default haiku), SINGULAR_E2E_BUDGET
#      (per-call --max-budget-usd, default 0.5), SINGULAR_E2E_TMP (work dir), SINGULAR_E2E_SONNET=0.
# Needs: claude (logged in), node >= 20, git. Prints SKIP and exits 0 when claude is missing or not logged in.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "SKIP  node not found on PATH"
  exit 0
fi
exec node "$ROOT/test/e2e/run.mjs" "$@"
