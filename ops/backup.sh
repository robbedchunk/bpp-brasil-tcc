#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_ROOT/ops/lib.sh"
select_node_24 backup
DATABASE_PATH="${DATABASE_PATH:-$PROJECT_ROOT/data/precos.sqlite}"
BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-$PROJECT_ROOT/var/backups}"
ATTESTATION_KEY_PATH="${ATTESTATION_KEY_PATH:-$PROJECT_ROOT/var/operations/validation-attestation-private.pem}"
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

create_backup_bundle() {
  local source="$1"
  local artifact="$2"
  local receipt="${artifact}.receipt.json"
  local runtime
  if [[ -f "$PROJECT_ROOT/dist/ops/scheduled-backup.js" ]]; then
    runtime=(node "$PROJECT_ROOT/dist/ops/scheduled-backup.js")
  elif [[ -x "$PROJECT_ROOT/node_modules/.bin/tsx" ]]; then
    runtime=("$PROJECT_ROOT/node_modules/.bin/tsx" "$PROJECT_ROOT/src/ops/scheduled-backup.ts")
  else
    printf 'backup: scheduled backup receipt runtime is unavailable; run npm run build\n' >&2
    return 1
  fi
  "${runtime[@]}" create \
    --source "$source" \
    --artifact "$artifact" \
    --receipt "$receipt" \
    --invocation-id "${INVOCATION_ID:-}"
}

remove_backup_bundle() {
  local parent="$1"
  # The checkpoint command owns and closes its SQLite handle before any member
  # of the bundle is unlinked. A malformed expired artifact is still removable.
  sqlite3 "$parent" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
  rm -f -- "${parent}-wal" "${parent}-shm" "${parent}.receipt.json" "$parent"
}

rotate_backups() {
  local directory="$1"
  local now_epoch="${2:-$(date +%s)}"
  local retention_cutoff=$((now_epoch - 14 * 24 * 60 * 60))
  local parent sidecar
  while IFS= read -r -d '' parent; do
    remove_backup_bundle "$parent"
  done < <(find "$directory" -type f -name 'precos-*.sqlite' \
    ! -newermt "@${retention_cutoff}" -print0)
  while IFS= read -r -d '' sidecar; do
    parent="${sidecar%-wal}"
    parent="${parent%-shm}"
    if [[ ! -f "$parent" ]]; then
      rm -f -- "$sidecar"
    fi
  done < <(find "$directory" -type f \
    \( -name 'precos-*.sqlite-wal' -o -name 'precos-*.sqlite-shm' \) -print0)
  while IFS= read -r -d '' sidecar; do
    parent="${sidecar%.receipt.json}"
    if [[ ! -f "$parent" ]]; then
      rm -f -- "$sidecar"
    fi
  done < <(find "$directory" -type f -name 'precos-*.sqlite.receipt.json' -print0)
  find "$directory" -type f -name 'validation-attestation-private-*.pem' \
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
if [[ -n "${INVOCATION_ID:-}" && ! "${INVOCATION_ID}" =~ ^[[:xdigit:]]{32}$ ]]; then
  printf 'backup: INVOCATION_ID must be 32 hexadecimal characters\n' >&2
  exit 1
fi
install -d -m 0700 "$BACKUP_DIRECTORY"
timestamp="$(TZ=America/Sao_Paulo date +%Y%m%dT%H%M%S)"
destination="$BACKUP_DIRECTORY/precos-$timestamp-$$.sqlite"
temporary_key=""
key_destination=""
receipt_complete=0
cleanup() {
  if [[ -n "$temporary_key" ]]; then
    rm -f -- "$temporary_key"
  fi
  if [[ "$receipt_complete" != "1" ]]; then
    rm -f -- "$destination" "${destination}-wal" "${destination}-shm" "${destination}.receipt.json"
    if [[ -n "$key_destination" ]]; then
      rm -f -- "$key_destination"
    fi
  fi
}
trap cleanup EXIT
if [[ -f "$ATTESTATION_KEY_PATH" ]]; then
  if [[ "$(stat -c '%a' "$ATTESTATION_KEY_PATH")" != "600" ]] \
    || ! grep -q -- 'BEGIN PRIVATE KEY' "$ATTESTATION_KEY_PATH"; then
    printf 'backup: validation signing key must be a mode-0600 private PEM file\n' >&2
    exit 1
  fi
  key_destination="$BACKUP_DIRECTORY/validation-attestation-private-$timestamp-$$.pem"
  temporary_key="${key_destination}.tmp"
  install -m 0600 "$ATTESTATION_KEY_PATH" "$temporary_key"
  mv -f -- "$temporary_key" "$key_destination"
  temporary_key=""
fi
if ! create_backup_bundle "$DATABASE_PATH" "$destination"; then
  exit 1
fi
receipt_complete=1
rotate_backups "$BACKUP_DIRECTORY"
trap - EXIT
printf 'backup: %s\n' "$destination"
