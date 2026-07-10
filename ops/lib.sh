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

migrate_legacy_database() {
  local source="$1"
  local destination="$2"

  [[ -e "$source" ]] || return 0
  if [[ -e "$destination" ]]; then
    if database_has_evidence "$source"; then
      printf 'database-migration: refusing to overwrite %s with populated legacy database %s.\n' \
        "$destination" "$source" >&2
      return 1
    fi
    return 0
  fi

  install -d -m 0700 "$(dirname "$destination")"
  local escaped_destination="${destination//\'/\'\'}"
  sqlite3 "$source" ".backup '$escaped_destination'"
  chmod 0600 "$destination"
}
