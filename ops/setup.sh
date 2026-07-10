#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

select_node_24() {
  if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(`.`)[0]')" == "24" ]]; then
    return
  fi

  local candidate
  for candidate in "$HOME"/.nvm/versions/node/v24*/bin/node; do
    if [[ -x "$candidate" ]]; then
      export PATH="$(dirname "$candidate"):$PATH"
      break
    fi
  done

  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(`.`)[0]')" != "24" ]]; then
    printf 'setup: Node >=24 <25 is required.\n' >&2
    exit 1
  fi
}

select_node_24

if [[ "$(npm --version | cut -d. -f1)" != "11" ]]; then
  printf 'setup: npm >=11 <12 is required.\n' >&2
  exit 1
fi

npm ci

if ! node --input-type=module -e \
  'import { existsSync } from "node:fs"; import { chromium } from "playwright"; process.exit(existsSync(chromium.executablePath()) ? 0 : 1)'; then
  npx playwright install chromium
fi

CHROMIUM_PATH="$(node --input-type=module -e 'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath())')"
if command -v ldd >/dev/null 2>&1 && ldd "$CHROMIUM_PATH" 2>/dev/null | grep -q 'not found'; then
  npx playwright install-deps chromium
fi

install -d -m 0700 var var/backups var/log var/replay
npm run --silent cli -- db init >/dev/null

if [[ "${INSTALL_TIMERS:-0}" == "1" ]]; then
  TIMER_SOURCE="$PROJECT_ROOT/ops/systemd"
  TIMER_DESTINATION="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  if [[ ! -d "$TIMER_SOURCE" ]]; then
    printf 'setup: no user timer definitions are available yet.\n' >&2
    exit 1
  fi

  install -d -m 0700 "$TIMER_DESTINATION"
  install -m 0600 "$TIMER_SOURCE"/precos-* "$TIMER_DESTINATION"/
  systemctl --user daemon-reload
  while IFS= read -r timer; do
    systemctl --user enable --now "$(basename "$timer")"
  done < <(find "$TIMER_SOURCE" -maxdepth 1 -name 'precos-*.timer' -type f -print)
fi

printf 'setup: ready.\n'
