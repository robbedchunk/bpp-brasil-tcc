#!/usr/bin/env bash

select_node_24() {
  local caller="${1:-operations}"
  if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(`.`)[0]' 2>/dev/null)" == "24" ]]; then
    return
  fi

  local candidate
  for candidate in "$HOME"/.nvm/versions/node/v24*/bin/node; do
    if [[ -x "$candidate" ]] && [[ "$("$candidate" -p 'process.versions.node.split(`.`)[0]' 2>/dev/null)" == "24" ]]; then
      export PATH="$(dirname "$candidate"):$PATH"
      return
    fi
  done

  printf '%s: Node >=24 <25 is required.\n' "$caller" >&2
  return 1
}

database_has_evidence() {
  local database="$1"
  local table escaped count
  while IFS= read -r table; do
    escaped="${table//\"/\"\"}"
    count="$(sqlite3 "$database" "SELECT EXISTS(SELECT 1 FROM \"$escaped\" LIMIT 1);")"
    if [[ "$count" == "1" ]]; then
      return 0
    fi
  done < <(sqlite3 "$database" \
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name;")
  return 1
}

database_fingerprint() {
  sqlite3 "$1" '.sha3sum --schema'
}

database_file_identity() {
  stat -Lc '%d:%i' "$1"
}

write_legacy_migration_marker() {
  local marker="$1"
  local source_fingerprint="$2"
  local destination_identity="$3"
  local temporary_marker="${marker}.tmp-$$-${RANDOM}"
  (umask 077; printf '%s %s\n' "$source_fingerprint" "$destination_identity" > "$temporary_marker")
  chmod 0600 "$temporary_marker"
  mv -f -- "$temporary_marker" "$marker"
}

migrate_legacy_database() {
  local source="$1"
  local destination="$2"
  local marker="${destination}.legacy-migration"

  [[ -e "$source" ]] || return 0
  if [[ -e "$destination" ]]; then
    if database_has_evidence "$source"; then
      local source_fingerprint destination_identity marked_source marked_destination
      source_fingerprint="$(database_fingerprint "$source")"
      destination_identity="$(database_file_identity "$destination")"
      if [[ -f "$marker" ]]; then
        read -r marked_source marked_destination < "$marker" || true
        if [[ "$marked_source" == "$source_fingerprint" \
          && "$marked_destination" == "$destination_identity" ]]; then
          return 0
        fi
      elif [[ "$(database_fingerprint "$destination")" == "$source_fingerprint" ]]; then
        write_legacy_migration_marker "$marker" "$source_fingerprint" "$destination_identity"
        return 0
      fi
      printf 'database-migration: refusing to overwrite %s with populated legacy database %s.\n' \
        "$destination" "$source" >&2
      return 1
    fi
    return 0
  fi

  install -d -m 0700 "$(dirname "$destination")"
  local temporary_destination="${destination}.migration-$$-${RANDOM}"
  local escaped_temporary="${temporary_destination//\'/\'\'}"
  sqlite3 "$source" ".backup '$escaped_temporary'"
  chmod 0600 "$temporary_destination"
  if ! ln -- "$temporary_destination" "$destination" 2>/dev/null; then
    rm -f -- "$temporary_destination"
    if [[ -e "$destination" ]]; then
      migrate_legacy_database "$source" "$destination"
      return
    fi
    return 1
  fi
  rm -f -- "$temporary_destination"
  write_legacy_migration_marker \
    "$marker" \
    "$(database_fingerprint "$source")" \
    "$(database_file_identity "$destination")"
}
