#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_ROOT/ops/lib.sh"
select_node_24 timer-install

NODE_PATH="$(command -v node)"
NPM_PATH="$(command -v npm)"
TEMPLATE_SOURCE="$PROJECT_ROOT/ops/systemd"
UNIT_DESTINATION="${SYSTEMD_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"

if [[ "$NODE_PATH" != /* || "$NPM_PATH" != /* || "$PROJECT_ROOT" != /* ]]; then
  printf 'timer-install: Node, npm, and project paths must be absolute.\n' >&2
  exit 1
fi

install -d -m 0700 "$UNIT_DESTINATION"
"$NODE_PATH" --input-type=module - \
  "$TEMPLATE_SOURCE" "$UNIT_DESTINATION" "$PROJECT_ROOT" "$NODE_PATH" "$NPM_PATH" <<'NODE'
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [templateSource, destination, projectRoot, nodePath, npmPath] = process.argv.slice(2);
if ([templateSource, destination, projectRoot, nodePath, npmPath].some((value) => value === undefined)) {
  throw new Error("missing systemd renderer argument");
}

function systemdQuote(value) {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("systemd paths cannot contain newlines");
  }
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`;
}

const replacements = new Map([
  ["@PROJECT_ROOT@", systemdQuote(projectRoot)],
  ["@NODE_PATH@", systemdQuote(nodePath)],
  ["@NPM_PATH@", systemdQuote(npmPath)],
  ["@RUNTIME_PATH@", systemdQuote(`PATH=${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`)],
]);

for (const unit of ["precos-status.service", "precos-status.timer"]) {
  let content = readFileSync(join(templateSource, unit), "utf8");
  for (const [placeholder, value] of replacements) {
    content = content.replaceAll(placeholder, value);
  }
  const outputPath = join(destination, unit);
  writeFileSync(outputPath, content, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
}
NODE

if [[ "${SYSTEMD_DRY_RUN:-0}" == "1" ]]; then
  exit 0
fi

systemctl --user daemon-reload
systemctl --user enable --now precos-status.timer
