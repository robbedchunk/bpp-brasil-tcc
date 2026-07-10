#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_ROOT/ops/lib.sh"
select_node_24 heartbeat-check

if [[ ! -f "$PROJECT_ROOT/dist/cli.js" ]]; then
  npm --prefix "$PROJECT_ROOT" run build >/dev/null
fi
exec node "$PROJECT_ROOT/dist/cli.js" heartbeat check --json
