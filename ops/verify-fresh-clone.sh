#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_ROOT/ops/lib.sh"
select_node_24 fresh-clone

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
git clone --no-local --quiet "$PROJECT_ROOT" "$clone_root"

source_commit="$(git -C "$clone_root" rev-parse HEAD)"
export HOME="$home_root"
export PROJECT_ROOT="$clone_root"
export DATABASE_PATH=var/acceptance/precos.sqlite
export TZ=America/Sao_Paulo
unset OPENAI_API_KEY CODEX_API_KEY NTFY_TOPIC LIVE_OPENAI

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

database_absolute="$clone_root/$DATABASE_PATH"
sqlite3 "$database_absolute" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
rm -f -- "${database_absolute}-wal" "${database_absolute}-shm"

[[ ! -e "$clone_root/.env" ]]
[[ "$(find "$clone_root/data/raw-html" "$clone_root/var/log" "$clone_root/var/backups" \
  -type f 2>/dev/null | wc -l)" == "0" ]]
[[ "$(find "$clone_root" -type f \( -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) | wc -l)" == "0" ]]

node_version="$(node --version)"
npm_version="$(npm --version)"
python_version="$(python3 --version 2>&1 | awk '{print $2}')"
analysis_latest="analysis/output/latest.json"
exports_latest="data/exports/latest.json"
analysis_hash="$(sha256sum "$clone_root/$analysis_latest" | cut -d' ' -f1)"
exports_hash="$(sha256sum "$clone_root/$exports_latest" | cut -d' ' -f1)"
completed_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

arguments=("$source_commit" "$completed_at" "$node_version" "$npm_version" "$python_version")
for index in "${!check_ids[@]}"; do
  arguments+=("${check_ids[$index]}=${check_hashes[$index]}")
done
arguments+=("--artifacts" "$analysis_latest=$analysis_hash" "$exports_latest=$exports_hash")

node --input-type=module - "${arguments[@]}" <<'NODE'
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
