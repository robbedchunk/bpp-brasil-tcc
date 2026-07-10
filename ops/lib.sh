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
