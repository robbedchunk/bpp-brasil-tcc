#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_PATH="${DATABASE_PATH:-$PROJECT_ROOT/data/precos.sqlite}"
BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-$PROJECT_ROOT/var/backups}"
SELF_TEST=0
RETENTION_SELF_TEST=0

if [[ "${1:-}" == "--self-test" ]]; then
  SELF_TEST=1
elif [[ "${1:-}" == "--retention-self-test" ]]; then
  RETENTION_SELF_TEST=1
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--self-test|--retention-self-test]\n' "$0" >&2
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

rotate_backups() {
  local directory="$1"
  local now_epoch="${2:-$(date +%s)}"
  local retention_cutoff=$((now_epoch - 14 * 24 * 60 * 60))
  find "$directory" -type f -name 'precos-*.sqlite' \
    ! -newermt "@${retention_cutoff}" -delete
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

if [[ "$RETENTION_SELF_TEST" == "1" ]]; then
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT
  now_epoch="${RETENTION_NOW_EPOCH:-$(date +%s)}"
  old="$temporary/precos-old.sqlite"
  recent="$temporary/precos-recent.sqlite"
  : >"$old"
  : >"$recent"
  touch -d "@$((now_epoch - 15 * 24 * 60 * 60))" "$old"
  touch -d "@$((now_epoch - 13 * 24 * 60 * 60))" "$recent"
  rotate_backups "$temporary" "$now_epoch"
  [[ ! -e "$old" && -e "$recent" ]]
  printf 'backup: retention self-test ok\n'
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
rotate_backups "$BACKUP_DIRECTORY"
printf 'backup: %s\n' "$destination"
