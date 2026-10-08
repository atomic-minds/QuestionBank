#!/usr/bin/env bash
# Runs the real migrations on a throwaway local PostgreSQL and executes tests/sql/*.sql.
#
#   ./scripts/test-sql.sh
#
# Needs PostgreSQL server binaries (initdb, pg_ctl, postgres, psql) with the
# pg_trgm and pgcrypto contrib extensions. Override with PGBIN=/path/to/bin.
# If run as root, it re-executes itself as a non-root user (Postgres refuses to
# run as root); set QB_TEST_USER to choose which one (default: claude).
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  exec runuser -u "${QB_TEST_USER:-claude}" -- env PGBIN="${PGBIN:-}" "$0" "$@"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [ ! -x "${PGBIN:-/nonexistent}/postgres" ]; then
  PGBIN="$(dirname "$(command -v postgres 2>/dev/null || true)")"
fi
[ -x "$PGBIN/postgres" ] || { echo "PostgreSQL server binaries not found (set PGBIN)"; exit 2; }

PORT="${PGPORT:-54329}"
DATA="$(mktemp -d)"
LOG="$DATA/server.log"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA/db" -A trust -U postgres -E UTF8 --locale=C.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA/db" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$LOG" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$DATA" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database qbtest encoding 'UTF8' template template0 lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'"

echo "== stub"
"${PSQL[@]}" -d qbtest -f "$ROOT/tests/sql/00_stub.sql"

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "== migrate $(basename "$f")"
  "${PSQL[@]}" -d qbtest -f "$f"
done

OUT="$DATA/results.txt"
: > "$OUT"
status=0
for t in "$ROOT"/tests/sql/[1-9]*.sql; do
  name="$(basename "$t" .sql)"
  echo "== test $name"
  # Capture psql's REAL exit status (a pipe would hide it).
  set +e
  "${PSQL[@]}" -d qbtest -f "$t" > "$DATA/cur.txt" 2>&1
  rc=$?
  set -e
  cat "$DATA/cur.txt" >> "$OUT"
  if [ -n "${VERBOSE:-}" ]; then grep -E 'ok - ' "$DATA/cur.txt" || true; fi
  grep -vE 'NOTICE:  ok - ' "$DATA/cur.txt" || true      # show anything that is not a pass
  if [ "$rc" != 0 ]; then echo "!! psql exited with status $rc in $name"; status=1; fi
  # The test file must reach its own last line, otherwise it stopped early.
  if ! grep -q "ok - END OF $name" "$DATA/cur.txt"; then
    echo "!! $name did not reach its end marker (stopped early)"; status=1
  fi
done

passed=$(grep -c 'NOTICE:  ok - ' "$OUT" || true)
failed=$(grep -ciE 'FAIL:|error:|warning:' "$OUT" || true)
echo
echo "passed: $passed   failed: $failed"
[ "$failed" = 0 ] && [ "$status" = 0 ]
