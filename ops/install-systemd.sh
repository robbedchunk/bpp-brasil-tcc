#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SOURCE_ROOT/ops/lib.sh"
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
BASH_PATH="$(command -v bash)"
INSTALL_RECEIPT="${SYSTEMD_INSTALL_RECEIPT:-$SOURCE_ROOT/var/operations/systemd-install.json}"
RELEASES_ROOT="${PRECOS_RELEASE_ROOT:-$HOME/.local/share/precos/releases}"
if [[ "$DRY_RUN" == "1" && -z "${SYSTEMD_UNIT_DIR+x}" ]]; then
  UNIT_DESTINATION="$(mktemp -d)"
  trap 'rm -rf "$UNIT_DESTINATION"' EXIT
else
  UNIT_DESTINATION="${SYSTEMD_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
fi

for path in "$SOURCE_ROOT" "$NODE_PATH" "$NPM_PATH" "$BASH_PATH" "$INSTALL_RECEIPT" "$RELEASES_ROOT"; do
  if [[ "$path" != /* ]]; then
    printf 'systemd-install: runtime, receipt, source, and release paths must be absolute.\n' >&2
    exit 1
  fi
done

release_fields() {
  local release_path="$1"
  "$NODE_PATH" "$release_path/dist/ops/release-manifest.js" verify \
    "$release_path" "$SOURCE_ROOT/ops/validation-attestation-public.pem" >/dev/null
  "$NODE_PATH" --input-type=module - "$release_path/release-manifest.json" <<'NODE'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(`${manifest.releasePath}\0${manifest.releaseId}\0${manifest.sourceCommit}\0${manifest.sourceRoot}\0${manifest.deployedAt}\0`);
NODE
}

RELEASE_PATH=""
RELEASE_ID=""
SOURCE_COMMIT=""
RELEASE_SOURCE_ROOT="$SOURCE_ROOT"
DEPLOYED_AT=""
if [[ "$DRY_RUN" == "1" ]]; then
  candidate="${PRECOS_RELEASE_PATH:-}"
  if [[ -z "$candidate" && -f "$INSTALL_RECEIPT" ]]; then
    candidate="$($NODE_PATH --input-type=module - "$INSTALL_RECEIPT" <<'NODE'
import { readFileSync } from "node:fs";
try {
  const receipt = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (receipt.schemaVersion === 2 && typeof receipt.releasePath === "string") {
    process.stdout.write(receipt.releasePath);
  }
} catch { /* Invalid receipts never select a release. */ }
NODE
)"
  fi
  if [[ -n "$candidate" ]]; then
    if ! IFS= read -r -d '' RELEASE_PATH \
      || ! IFS= read -r -d '' RELEASE_ID \
      || ! IFS= read -r -d '' SOURCE_COMMIT \
      || ! IFS= read -r -d '' RELEASE_SOURCE_ROOT \
      || ! IFS= read -r -d '' DEPLOYED_AT; then
      printf 'systemd-install: selected frozen release is invalid.\n' >&2
      exit 1
    fi < <(release_fields "$(realpath -e -- "$candidate")")
  else
    # A first dry-run remains non-mutating. It previews the paths a release would
    # freeze; after installation, dry-runs strictly reuse the installed release.
    RELEASE_PATH="$SOURCE_ROOT"
    SOURCE_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD 2>/dev/null \
      || printf '%040d' 0)"
    RELEASE_ID="00000000000000000000000000000000"
    DEPLOYED_AT="1970-01-01T00:00:00.000Z"
  fi
else
  if [[ -n "$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
    printf 'systemd-install: deployment requires a completely clean committed source tree.\n' >&2
    exit 1
  fi
  release_json="$($NODE_PATH "$SOURCE_ROOT/scripts/create-release.mjs" \
    --source-root "$SOURCE_ROOT" \
    --release-root "$RELEASES_ROOT" \
    --npm-path "$NPM_PATH")"
  if ! IFS= read -r -d '' RELEASE_PATH \
    || ! IFS= read -r -d '' RELEASE_ID \
    || ! IFS= read -r -d '' SOURCE_COMMIT \
    || ! IFS= read -r -d '' RELEASE_SOURCE_ROOT \
    || ! IFS= read -r -d '' DEPLOYED_AT; then
    printf 'systemd-install: release builder returned invalid output.\n' >&2
    exit 1
  fi < <($NODE_PATH --input-type=module - "$release_json" <<'NODE'
const value = JSON.parse(process.argv[2]);
const manifest = JSON.parse((await import("node:fs")).readFileSync(`${value.releasePath}/release-manifest.json`, "utf8"));
process.stdout.write(`${value.releasePath}\0${value.releaseId}\0${value.sourceCommit}\0${manifest.sourceRoot}\0${value.deployedAt}\0`);
NODE
)
  release_fields "$RELEASE_PATH" >/dev/null
fi

if [[ "$RELEASE_PATH" != /* || "$RELEASE_SOURCE_ROOT" != /* \
  || ! "$RELEASE_ID" =~ ^[a-f0-9]{32}$ || ! "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'systemd-install: release identity is malformed.\n' >&2
  exit 1
fi

UNIT_SOURCE="$RELEASE_PATH/ops"
install -d -m 0700 "$UNIT_DESTINATION"
"$NODE_PATH" --input-type=module - \
  "$UNIT_SOURCE" "$UNIT_DESTINATION" "$RELEASE_PATH" "$RELEASE_SOURCE_ROOT" \
  "$RELEASE_ID" "$NODE_PATH" "$BASH_PATH" <<'NODE'
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [source, destination, releaseRoot, sourceRoot, releaseId, nodePath, bashPath] = process.argv.slice(2);
if ([source, destination, releaseRoot, sourceRoot, releaseId, nodePath, bashPath]
  .some((value) => value === undefined)) throw new Error("missing systemd renderer argument");
for (const value of [releaseRoot, sourceRoot, releaseId, nodePath, bashPath]) {
  if (value.includes("\n") || value.includes("\r")) throw new Error("invalid newline in systemd value");
}

function systemdQuote(value, escapeDollar = false) {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (character === "%") escaped += "%%";
    else if (character === "$" && escapeDollar) escaped += "$$";
    else if (character === "\t") escaped += "\\t";
    else if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else escaped += character;
  }
  return `"${escaped}"`;
}

function systemdPath(value) {
  let escaped = "";
  for (const character of value) {
    if (/^[A-Za-z0-9/_.:+-]$/u.test(character)) escaped += character;
    else if (character === "%") escaped += "%%";
    else for (const byte of Buffer.from(character)) {
      escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return escaped;
}

const replacements = new Map([
  ["@RELEASE_ROOT@", systemdPath(releaseRoot)],
  ["@NODE_PATH@", systemdQuote(nodePath, true)],
  ["@BASH_PATH@", systemdQuote(bashPath, true)],
  ["@CLI_PATH@", systemdQuote(join(releaseRoot, "dist", "cli.js"), true)],
  ["@RELEASE_VERIFY_PATH@", systemdQuote(join(releaseRoot, "dist", "ops", "release-manifest.js"), true)],
  ["@RELEASE_ROOT_QUOTED@", systemdQuote(releaseRoot, true)],
  ["@PUBLIC_KEY_PATH@", systemdQuote(join(sourceRoot, "ops", "validation-attestation-public.pem"), true)],
  ["@BACKUP_PATH@", systemdQuote(join(releaseRoot, "ops", "backup.sh"), true)],
  ["@WEEKLY_INDEX_PATH@", systemdQuote(join(releaseRoot, "ops", "run-weekly-index.sh"), true)],
  ["@ENV_FILE@", `-${systemdPath(join(sourceRoot, ".env"))}`],
  ["@RELEASE_ID_ENV@", systemdQuote(`PRECOS_RELEASE_ID=${releaseId}`)],
  ["@RUNTIME_PATH@", systemdQuote(`PATH=${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`)],
]);
const timerNames = ["daily", "healing", "weekly-index", "weekly-discovery", "heartbeat", "backup"];
const units = [
  ...timerNames.flatMap((name) => [`precos-${name}.service`, `precos-${name}.timer`]),
  "precos-classification.service",
];
for (const unit of units) {
  let content = readFileSync(join(source, unit), "utf8");
  for (const [placeholder, value] of replacements) content = content.replaceAll(placeholder, () => value);
  if (/@[A-Z][A-Z_]+@/u.test(content)) throw new Error(`unresolved systemd placeholder in ${unit}`);
  const path = join(destination, unit);
  writeFileSync(path, content, { mode: 0o644 });
  chmodSync(path, 0o644);
}
NODE

if [[ "$DRY_RUN" == "1" ]]; then
  printf 'release %s %s\n' "$RELEASE_ID" "$RELEASE_PATH"
  printf 'rendered precos-classification.service\n'
  for timer in daily healing weekly-index weekly-discovery heartbeat backup; do
    printf 'rendered precos-%s.timer\n' "$timer"
  done
  exit 0
fi

LOGIN_USER="$(id -un)"
if [[ "$(loginctl show-user "$LOGIN_USER" --property=Linger --value 2>/dev/null || true)" != "yes" ]]; then
  sudo -n loginctl enable-linger "$LOGIN_USER"
fi
if [[ "$(loginctl show-user "$LOGIN_USER" --property=Linger --value 2>/dev/null || true)" != "yes" ]]; then
  printf 'systemd-install: user linger could not be enabled and verified.\n' >&2
  exit 1
fi

systemctl --user daemon-reload
systemctl --user disable --now precos-status.timer >/dev/null 2>&1 || true
systemctl --user enable --now \
  precos-daily.timer \
  precos-healing.timer \
  precos-weekly-index.timer \
  precos-weekly-discovery.timer \
  precos-heartbeat.timer \
  precos-backup.timer

install -d -m 0700 "$(dirname "$INSTALL_RECEIPT")"
"$NODE_PATH" --input-type=module - \
  "$UNIT_DESTINATION" "$INSTALL_RECEIPT" "$RELEASE_PATH" "$RELEASE_ID" \
  "$SOURCE_COMMIT" "$DEPLOYED_AT" <<'NODE'
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [unitDirectory, destination, releasePath, releaseId, sourceCommit, deployedAt] = process.argv.slice(2);
if ([unitDirectory, destination, releasePath, releaseId, sourceCommit, deployedAt]
  .some((value) => value === undefined)) throw new Error("missing install receipt argument");
const timerNames = ["backup", "daily", "healing", "heartbeat", "weekly-discovery", "weekly-index"];
const names = [
  ...timerNames.flatMap((name) => [`precos-${name}.service`, `precos-${name}.timer`]),
  "precos-classification.service",
].sort();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const units = names.map((name) => ({ name, sha256: sha256(readFileSync(join(unitDirectory, name))) }));
const unitSetSha256 = sha256(units.map((unit) => `${unit.name}\0${unit.sha256}\n`).join(""));
const now = new Date();
let scheduleActivatedAt = now.toISOString();
if (existsSync(destination)) {
  try {
    const previous = JSON.parse(readFileSync(destination, "utf8"));
    const candidate = previous.schemaVersion === 2
      ? previous.scheduleActivatedAt
      : previous.schemaVersion === 1 ? previous.installedAt : undefined;
    const previousTime = typeof candidate === "string" ? Date.parse(candidate) : Number.NaN;
    if (Number.isFinite(previousTime) && previousTime <= now.getTime()) scheduleActivatedAt = candidate;
  } catch { /* Malformed receipts never authorize timestamp preservation. */ }
}
const manifestPath = join(releasePath, "release-manifest.json");
const receipt = {
  schemaVersion: 2,
  scheduleActivatedAt,
  deployedAt,
  sourceCommit,
  releaseId,
  releasePath,
  releaseManifestSha256: sha256(readFileSync(manifestPath)),
  unitSetSha256,
  units,
};
const temporary = `${destination}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
chmodSync(temporary, 0o600);
renameSync(temporary, destination);
NODE

printf 'systemd-install: deployed release %s (%s).\n' "$RELEASE_ID" "$SOURCE_COMMIT"
