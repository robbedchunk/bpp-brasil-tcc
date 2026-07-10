#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ -x "$HOME/.nvm/versions/node/v24.18.0/bin/node" ]]; then
  export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(`.`)[0]')" != "24" ]]; then
  printf 'smoke: Node >=24 <25 is required.\n' >&2
  exit 1
fi

npm run typecheck
npm test
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
