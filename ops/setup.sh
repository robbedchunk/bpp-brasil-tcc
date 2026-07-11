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
"$PROJECT_ROOT/ops/setup-analysis.sh"

if ! node --input-type=module -e \
  'import { existsSync } from "node:fs"; import { chromium } from "playwright"; process.exit(existsSync(chromium.executablePath()) ? 0 : 1)'; then
  npx playwright install chromium
fi

CHROMIUM_PATH="$(node --input-type=module -e 'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath())')"
if command -v ldd >/dev/null 2>&1 && ldd "$CHROMIUM_PATH" 2>/dev/null | grep -q 'not found'; then
  npx playwright install-deps chromium
fi

install -d -m 0700 data data/raw-html var var/backups var/log var/operations var/replay
migrate_legacy_database "$PROJECT_ROOT/var/precos.sqlite" "$PROJECT_ROOT/data/precos.sqlite"
DATABASE_PATH="${DATABASE_PATH:-data/precos.sqlite}" npm run --silent cli -- db init >/dev/null
VALIDATION_PRIVATE_KEY="$PROJECT_ROOT/var/operations/validation-attestation-private.pem"
VALIDATION_PUBLIC_KEY="$PROJECT_ROOT/ops/validation-attestation-public.pem"
if [[ -f "$VALIDATION_PRIVATE_KEY" || ! -f "$VALIDATION_PUBLIC_KEY" ]]; then
  npm run --silent strategies:key:init >/dev/null
else
  printf 'setup: validation receipts are verification-only until the matching private key is restored.\n'
fi

STRATEGY_COUNT="$(DATABASE_PATH="${DATABASE_PATH:-data/precos.sqlite}" node --input-type=module -e '
  import Database from "better-sqlite3";
  const database = new Database(process.env.DATABASE_PATH, { readonly: true });
  try {
    process.stdout.write(String(database.prepare("SELECT COUNT(*) AS count FROM strategies").get().count));
  } finally {
    database.close();
  }
')"
if [[ "$STRATEGY_COUNT" == "0" ]]; then
  DATABASE_PATH="${DATABASE_PATH:-data/precos.sqlite}" \
    npm run --silent retailers:register -- --bootstrap-inactive >/dev/null
fi

if [[ "${INSTALL_TIMERS:-0}" == "1" ]]; then
  "$PROJECT_ROOT/ops/install-systemd.sh"
fi

printf 'setup: ready.\n'
