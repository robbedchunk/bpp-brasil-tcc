#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_PROJECT_ROOT="$PROJECT_ROOT"
receipt_destination=""
if [[ "${1:-}" == "--write-receipt" && -n "${2:-}" && $# -eq 2 ]]; then
  receipt_destination="$2"
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--write-receipt data/acceptance/evidence/fresh-clone.json]\n' "$0" >&2
  exit 2
fi
source "$PROJECT_ROOT/ops/lib.sh"
select_node_24 fresh-clone
git -C "$PROJECT_ROOT" rev-parse --show-toplevel >/dev/null
if [[ "$(npm --version | cut -d. -f1)" != "11" ]]; then
  printf 'fresh-clone: npm >=11 <12 is required.\n' >&2
  exit 1
fi

temporary_root="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT
chmod 0700 "$temporary_root"

clone_root="$temporary_root/repository"
home_root="$temporary_root/home"
logs_root="$temporary_root/logs"
mkdir -m 0700 "$home_root" "$logs_root"
source "$PROJECT_ROOT/ops/fresh-clone-environment.sh"
sanitize_fresh_clone_environment "$home_root"
git clone --no-local --quiet "$PROJECT_ROOT" "$clone_root"

source_commit="$(git -C "$clone_root" rev-parse HEAD)"
export PROJECT_ROOT="$clone_root"
export DATABASE_PATH=var/acceptance/precos.sqlite
export TZ=America/Sao_Paulo

check_ids=()
check_hashes=()
run_check() {
  local id="$1"
  shift
  local log="$logs_root/$id.log"
  if ! (cd "$clone_root" && "$@") >"$log" 2>&1; then
    printf 'fresh-clone: %s failed; private output retained only until cleanup.\n' "$id" >&2
    return 1
  fi
  check_ids+=("$id")
  check_hashes+=("$(sha256sum "$log" | cut -d' ' -f1)")
}

run_check setup bash ops/setup.sh
run_check smoke bash ops/smoke.sh
run_check publication npm run audit:publication -- --json
run_check analysis npm run analysis

while IFS= read -r -d '' database_absolute; do
  sqlite3 "$database_absolute" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
  rm -f -- "${database_absolute}-wal" "${database_absolute}-shm"
done < <(find "$clone_root/data" "$clone_root/var" -type f -name '*.sqlite' -print0)

[[ ! -e "$clone_root/.env" ]]
[[ "$(find "$clone_root/data/raw-html" "$clone_root/var/log" "$clone_root/var/backups" \
  -type f 2>/dev/null | wc -l)" == "0" ]]
[[ "$(find "$clone_root/var/acceptance" -type f ! -name 'precos.sqlite' 2>/dev/null | wc -l)" == "0" ]]
[[ "$(find "$clone_root/var" "$clone_root/data" -path '*browser-profile*' 2>/dev/null | wc -l)" == "0" ]]
[[ "$(find "$clone_root" -type f \( -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) | wc -l)" == "0" ]]

node_version="$(node --version)"
npm_version="$(npm --version)"
python_version="$(python3 --version 2>&1 | awk '{print $2}')"
analysis_snapshot="$(node -e 'const p=require(process.argv[1]);if(typeof p.snapshotDirectory!=="string")process.exit(1);process.stdout.write(p.snapshotDirectory)' "$clone_root/analysis/output/latest.json")"
exports_snapshot="$(node -e 'const p=require(process.argv[1]);if(typeof p.snapshotDirectory!=="string")process.exit(1);process.stdout.write(p.snapshotDirectory)' "$clone_root/data/exports/latest.json")"
analysis_manifest="analysis/output/$analysis_snapshot/manifest.json"
exports_manifest="data/exports/$exports_snapshot/manifest.json"
[[ -f "$clone_root/$analysis_manifest" && -f "$clone_root/$exports_manifest" ]]
analysis_hash="$(sha256sum "$clone_root/$analysis_manifest" | cut -d' ' -f1)"
exports_hash="$(sha256sum "$clone_root/$exports_manifest" | cut -d' ' -f1)"
completed_at="$(node --input-type=module -e 'process.stdout.write(new Date().toISOString())')"

arguments=("$source_commit" "$completed_at" "$node_version" "$npm_version" "$python_version")
for index in "${!check_ids[@]}"; do
  arguments+=("${check_ids[$index]}=${check_hashes[$index]}")
done
arguments+=("--artifacts" "$analysis_manifest=$analysis_hash" "$exports_manifest=$exports_hash")

receipt_file="$logs_root/fresh-clone.json"
node --input-type=module - "${arguments[@]}" >"$receipt_file" <<'NODE'
const [sourceCommit, completedAt, nodeVersion, npmVersion, pythonVersion, ...tail] = process.argv.slice(2);
const marker = tail.indexOf("--artifacts");
if (marker < 0) throw new Error("missing artifact marker");
const pairs = (values) => values.map((value) => {
  const split = value.indexOf("=");
  if (split < 1) throw new Error("invalid receipt pair");
  return [value.slice(0, split), value.slice(split + 1)];
});
const checks = pairs(tail.slice(0, marker)).map(([id, outputSha256]) => ({
  id,
  exitCode: 0,
  outputSha256,
}));
const artifacts = pairs(tail.slice(marker + 1)).map(([path, sha256]) => ({ path, sha256 }));
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: "pass",
  sourceCommit,
  completedAt,
  runtimes: { node: nodeVersion, npm: npmVersion, python: pythonVersion },
  checks,
  artifacts,
})}\n`);
NODE

node --input-type=module - "$receipt_file" "$clone_root" "$SOURCE_PROJECT_ROOT" "$receipt_destination" <<'NODE'
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const [receiptPath, cloneRoot, sourceRoot, requestedDestination] = process.argv.slice(2);
const value = JSON.parse(readFileSync(receiptPath, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const exactKeys = (object, keys) => Object.keys(object).sort().join("\0") === [...keys].sort().join("\0");
if (!exactKeys(value, ["schemaVersion", "status", "sourceCommit", "completedAt", "runtimes", "checks", "artifacts"])
  || value.schemaVersion !== 1 || value.status !== "pass"
  || !/^[a-f0-9]{40}$/.test(value.sourceCommit)
  || !/^v24\./.test(value.runtimes?.node) || !/^11\./.test(value.runtimes?.npm)) {
  throw new Error("fresh-clone receipt failed strict top-level validation");
}
const checkIds = value.checks.map((check) => check.id).sort();
if (checkIds.join("\0") !== ["analysis", "publication", "setup", "smoke"].join("\0")
  || value.checks.some((check) => check.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(check.outputSha256))) {
  throw new Error("fresh-clone receipt failed strict command validation");
}
if (value.artifacts.length !== 2
  || !value.artifacts.some((item) => /^analysis\/output\/snapshots\/[^/]+\/manifest\.json$/.test(item.path))
  || !value.artifacts.some((item) => /^data\/exports\/snapshots\/[^/]+\/manifest\.json$/.test(item.path))
  || value.artifacts.some((item) => isAbsolute(item.path) || item.path.split("/").includes("..")
    || !/^[a-f0-9]{64}$/.test(item.sha256) || sha256(resolve(cloneRoot, item.path)) !== item.sha256)) {
  throw new Error("fresh-clone receipt failed strict artifact validation");
}
if (requestedDestination !== "") {
  const destination = resolve(sourceRoot, requestedDestination);
  const expected = resolve(sourceRoot, "data/acceptance/evidence/fresh-clone.json");
  if (destination !== expected || relative(sourceRoot, destination).startsWith("..")) {
    throw new Error("fresh-clone receipt destination is not the public allowlisted path");
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const temporary = `${destination}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, destination);
}
NODE

cat "$receipt_file"
