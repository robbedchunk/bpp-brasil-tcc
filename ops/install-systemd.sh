#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_ROOT/ops/lib.sh"
select_node_24 systemd-install

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--dry-run]\n' "$0" >&2
  exit 2
fi

NODE_PATH="$(command -v node)"
NPM_PATH="$(command -v npm)"
if [[ "$DRY_RUN" == "1" && -z "${SYSTEMD_UNIT_DIR+x}" ]]; then
  UNIT_DESTINATION="$(mktemp -d)"
  trap 'rm -rf "$UNIT_DESTINATION"' EXIT
else
  UNIT_DESTINATION="${SYSTEMD_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
fi

if [[ "$NODE_PATH" != /* || "$NPM_PATH" != /* || "$PROJECT_ROOT" != /* ]]; then
  printf 'systemd-install: Node, npm, and project paths must be absolute.\n' >&2
  exit 1
fi

install -d -m 0700 "$UNIT_DESTINATION"
"$NODE_PATH" --input-type=module - \
  "$PROJECT_ROOT/ops" "$UNIT_DESTINATION" "$PROJECT_ROOT" "$NODE_PATH" "$NPM_PATH" "$HOME" <<'NODE'
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const [source, destination, projectRoot, nodePath, npmPath, home] = process.argv.slice(2);
if ([source, destination, projectRoot, nodePath, npmPath, home].some((value) => value === undefined)) {
  throw new Error("missing systemd renderer argument");
}
for (const value of [projectRoot, nodePath, npmPath, home]) {
  if (value.includes("\n") || value.includes("\r")) throw new Error("invalid newline in path");
}

const envFile = projectRoot === home || projectRoot.startsWith(`${home}/`)
  ? `%h/${relative(home, projectRoot)}/.env`.replace("%h//", "%h/")
  : `${projectRoot}/.env`;
const replacements = new Map([
  ["@PROJECT_ROOT@", projectRoot],
  ["@NODE_PATH@", nodePath],
  ["@NPM_PATH@", npmPath],
  ["@ENV_FILE@", envFile],
  ["@RUNTIME_PATH@", `PATH=${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`],
]);
const names = ["daily", "weekly-discovery", "heartbeat", "backup"];
for (const name of names) {
  for (const suffix of ["service", "timer"]) {
    const unit = `precos-${name}.${suffix}`;
    let content = readFileSync(join(source, unit), "utf8");
    for (const [placeholder, value] of replacements) {
      content = content.replaceAll(placeholder, value);
    }
    const path = join(destination, unit);
    writeFileSync(path, content, { mode: 0o644 });
    chmodSync(path, 0o644);
  }
}
NODE

if [[ "$DRY_RUN" == "1" ]]; then
  for timer in daily weekly-discovery heartbeat backup; do
    printf 'rendered precos-%s.timer\n' "$timer"
  done
  exit 0
fi

"$NPM_PATH" run build
systemctl --user daemon-reload
systemctl --user disable --now precos-status.timer >/dev/null 2>&1 || true
systemctl --user enable --now \
  precos-daily.timer \
  precos-weekly-discovery.timer \
  precos-heartbeat.timer \
  precos-backup.timer
