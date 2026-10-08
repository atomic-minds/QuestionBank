#!/usr/bin/env bash
# Starts a fresh throwaway stack (database + fake Supabase/Gemini) and runs the browser tests.
#   bash tests/e2e/run.sh [screenshot_dir]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHOTS="${1:-/tmp/qb-shots}"
LOG="$(mktemp)"
as_user() { if [ "$(id -u)" = 0 ]; then runuser -u "${QB_TEST_USER:-claude}" -- "$@"; else "$@"; fi; }
as_user node "$ROOT/tests/e2e/harness.mjs" > "$LOG" 2>&1 &
HPID=$!
trap 'pkill -TERM -u "${QB_TEST_USER:-claude}" -f "[h]arness\.mjs" 2>/dev/null; kill "$HPID" 2>/dev/null; wait 2>/dev/null' EXIT
for _ in $(seq 1 60); do grep -q READY "$LOG" && break; sleep 1; done
grep -q READY "$LOG" || { echo "stack did not start:"; cat "$LOG"; exit 2; }
python3 "$ROOT/tests/e2e/ui.py" "http://localhost:${PORT:-8787}" "$SHOTS"
