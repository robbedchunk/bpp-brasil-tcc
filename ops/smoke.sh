#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
source "$PROJECT_ROOT/ops/lib.sh"

select_node_24 smoke

npm run typecheck
npm test
npm run audit:publication -- --json --implementation-cut >/dev/null
install -d -m 0700 var var/backups var/log var/replay
npm run --silent cli -- db init >/dev/null

STATUS_JSON="$(npm run --silent cli -- status --json)"
node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(report.retailers) || typeof report.staleHeartbeat !== "boolean") {
      throw new Error("invalid status report");
    }
  });
' <<<"$STATUS_JSON"

printf '%s\n' "$STATUS_JSON"
