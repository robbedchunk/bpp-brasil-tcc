#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
source "$PROJECT_ROOT/ops/lib.sh"

select_node_24 setup

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
  "$PROJECT_ROOT/ops/install-status-timer.sh"
fi

printf 'setup: ready.\n'
