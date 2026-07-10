#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_PATH="${DATABASE_PATH:-$PROJECT_ROOT/data/precos.sqlite}"
BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-$PROJECT_ROOT/var/backups}"
SELF_TEST=0

if [[ "${1:-}" == "--self-test" ]]; then
  SELF_TEST=1
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--self-test]\n' "$0" >&2
  exit 2
fi

backup_database() {
  local source="$1"
  local destination="$2"
  local escaped_destination="${destination//\'/\'\'}"
  sqlite3 "$source" ".backup '$escaped_destination'"
  local integrity
  integrity="$(sqlite3 "$destination" 'PRAGMA integrity_check;')"
  if [[ "$integrity" != "ok" ]]; then
    printf 'backup: integrity check failed for %s: %s\n' "$destination" "$integrity" >&2
    return 1
  fi
  chmod 0600 "$destination"
}

if [[ "$SELF_TEST" == "1" ]]; then
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT
  sqlite3 "$temporary/source.sqlite" \
    "CREATE TABLE evidence(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO evidence(value) VALUES ('ok');"
  backup_database "$temporary/source.sqlite" "$temporary/backup.sqlite"
  [[ "$(sqlite3 "$temporary/backup.sqlite" 'SELECT value FROM evidence;')" == "ok" ]]
  printf 'backup: self-test ok\n'
  exit 0
fi

if [[ ! -f "$DATABASE_PATH" ]]; then
  printf 'backup: database not found: %s\n' "$DATABASE_PATH" >&2
  exit 1
fi
install -d -m 0700 "$BACKUP_DIRECTORY"
timestamp="$(TZ=America/Sao_Paulo date +%Y%m%dT%H%M%S)"
destination="$BACKUP_DIRECTORY/precos-$timestamp-$$.sqlite"
backup_database "$DATABASE_PATH" "$destination"
find "$BACKUP_DIRECTORY" -type f -name 'precos-*.sqlite' -mtime +14 -delete
printf 'backup: %s\n' "$destination"
