#!/usr/bin/env -S -i PRECOS_FRESH_CLONE_SANITIZED_ENTRY=1 PATH=/usr/local/bin:/usr/bin:/bin /bin/bash --noprofile --norc
set -euo pipefail

if [[ "${PRECOS_FRESH_CLONE_SANITIZED_ENTRY:-}" != "1" ]]; then
  printf 'fresh-clone: execute this verifier directly; do not invoke it through an ambient shell.\n' >&2
  exit 1
fi
unset PRECOS_FRESH_CLONE_SANITIZED_ENTRY

# The shebang clears the environment before Bash starts, so BASH_ENV and shell
# startup hooks cannot execute ahead of this file. Recover only the invoking
# account identity needed to discover its pinned Node 24 runtime.
entry_uid="$(/usr/bin/id -u)"
entry_record="$(/usr/bin/getent passwd "$entry_uid")" || {
  printf 'fresh-clone: cannot resolve the invoking account.\n' >&2
  exit 1
}
IFS=: read -r entry_user _ entry_record_uid _ _ entry_home _ <<<"$entry_record"
if [[ -z "$entry_user" || "$entry_record_uid" != "$entry_uid" || "$entry_home" != /* ]]; then
  printf 'fresh-clone: invoking account identity is malformed.\n' >&2
  exit 1
fi
export HOME="$entry_home" USER="$entry_user" LOGNAME="$entry_user"
export LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=America/Sao_Paulo

SCRIPT_PATH="$(/usr/bin/realpath -- "${BASH_SOURCE[0]}")"
for unsafe_name in NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH GLOBIGNORE \
  LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES \
  GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT; do
  [[ -z "${!unsafe_name+x}" ]] || {
    printf 'fresh-clone: sanitized entry inherited %s.\n' "$unsafe_name" >&2
    exit 1
  }
done
[[ "$PATH" == "/usr/local/bin:/usr/bin:/bin" && -z "$(declare -F)" ]] \
  || { printf 'fresh-clone: sanitized entry environment is not allowlisted.\n' >&2; exit 1; }
if shopt -q expand_aliases; then
  printf 'fresh-clone: aliases are forbidden in the sanitized entry.\n' >&2
  exit 1
fi

PROJECT_ROOT="$(cd "$(/usr/bin/dirname "$SCRIPT_PATH")/.." && pwd)"
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
TRUSTED_NODE_BIN="$(/usr/bin/dirname "$(command -v node)")"
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
export PATH="$TRUSTED_NODE_BIN:/usr/local/bin:/usr/bin:/bin"
select_node_24 fresh-clone
git clone --no-local --quiet "$PROJECT_ROOT" "$clone_root"

resolve_evaluated_commit() {
  local repository="$1"
  local candidate
  candidate="$(git -C "$repository" rev-parse HEAD)"
  while true; do
    local ancestry=()
    local paths=()
    local evidence_only=1
    read -r -a ancestry <<<"$(git -C "$repository" rev-list --parents -n 1 "$candidate")"
    mapfile -t paths < <(git -C "$repository" diff-tree --root --no-commit-id --name-only -r "$candidate")
    if [[ "${#ancestry[@]}" -ne 2 || "${#paths[@]}" -eq 0 ]]; then
      break
    fi
    for path in "${paths[@]}"; do
      if [[ "$path" =~ ^data/acceptance/evidence/classification-review-v[1-9][0-9]*\.json$ ]]; then
        continue
      fi
      case "$path" in
        data/acceptance/acceptance.json|\
        data/acceptance/evidence/alert-drill.json|\
        data/acceptance/evidence/backup-drill.json|\
        data/acceptance/evidence/fresh-clone.json|\
        data/acceptance/evidence/healing-sabotage-drill.json|\
        docs/acceptance-report.md) ;;
        *) evidence_only=0 ;;
      esac
    done
    if [[ "$evidence_only" -ne 1 ]]; then
      break
    fi
    candidate="${ancestry[1]}"
  done
  printf '%s\n' "$candidate"
}

source_commit="$(resolve_evaluated_commit "$clone_root")"
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
run_check publication npm run audit:publication -- --json --implementation-cut
run_check analysis npm run analysis

while IFS= read -r -d '' database_absolute; do
  sqlite3 "$database_absolute" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
  rm -f -- "${database_absolute}-wal" "${database_absolute}-shm"
done < <(find "$clone_root/data" "$clone_root/var" -type f -name '*.sqlite' -print0)

[[ ! -e "$clone_root/.env" ]]
[[ "$(find "$clone_root/data/raw-html" "$clone_root/var/log" "$clone_root/var/backups" \
  -type f 2>/dev/null | wc -l)" == "0" ]]
[[ "$(find "$clone_root/var/acceptance" -type f ! -name 'precos.sqlite' 2>/dev/null | wc -l)" == "0" ]]
[[ ! -e "$clone_root/var/acceptance/m5-healing" ]]
[[ "$(find "$clone_root/var" "$clone_root/data" -path '*browser-profile*' 2>/dev/null | wc -l)" == "0" ]]
[[ "$(find "$clone_root" -type f \( -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) | wc -l)" == "0" ]]

node_version="$(node --version)"
npm_version="$(npm --version)"
python_version="$(python3 --version 2>&1 | awk '{print $2}')"
clone_commit="$(git -C "$clone_root" rev-parse HEAD)"
git -C "$clone_root" merge-base --is-ancestor "$source_commit" "$clone_commit"
cmp -- "$SOURCE_PROJECT_ROOT/ops/verify-fresh-clone.sh" "$clone_root/ops/verify-fresh-clone.sh"
cmp -- "$SOURCE_PROJECT_ROOT/scripts/create-fresh-clone-receipt.mjs" \
  "$clone_root/scripts/create-fresh-clone-receipt.mjs"
if [[ -f "$SOURCE_PROJECT_ROOT/data/acceptance/evidence/healing-sabotage-drill.json" ]]; then
  cmp -- "$SOURCE_PROJECT_ROOT/data/acceptance/evidence/healing-sabotage-drill.json" \
    "$clone_root/data/acceptance/evidence/healing-sabotage-drill.json"
fi
verifier_hash="$({
  printf 'ops/verify-fresh-clone.sh\0'
  cat "$clone_root/ops/verify-fresh-clone.sh"
  printf '\0scripts/create-fresh-clone-receipt.mjs\0'
  cat "$clone_root/scripts/create-fresh-clone-receipt.mjs"
} | sha256sum | cut -d' ' -f1)"
analysis_snapshot="$(node -e 'const p=require(process.argv[1]);if(typeof p.snapshotDirectory!=="string")process.exit(1);process.stdout.write(p.snapshotDirectory)' "$clone_root/analysis/output/latest.json")"
exports_snapshot="$(node -e 'const p=require(process.argv[1]);if(typeof p.snapshotDirectory!=="string")process.exit(1);process.stdout.write(p.snapshotDirectory)' "$clone_root/data/exports/latest.json")"
analysis_manifest="analysis/output/$analysis_snapshot/manifest.json"
exports_manifest="data/exports/$exports_snapshot/manifest.json"
[[ -f "$clone_root/$analysis_manifest" && -f "$clone_root/$exports_manifest" ]]
analysis_hash="$(sha256sum "$clone_root/$analysis_manifest" | cut -d' ' -f1)"
exports_hash="$(sha256sum "$clone_root/$exports_manifest" | cut -d' ' -f1)"
completed_at="$(node --input-type=module -e 'process.stdout.write(new Date().toISOString())')"

arguments=("$source_commit" "$clone_commit" "$completed_at" "$verifier_hash" \
  "$node_version" "$npm_version" "$python_version")
for index in "${!check_ids[@]}"; do
  arguments+=("${check_ids[$index]}=${check_hashes[$index]}")
done
arguments+=("--artifacts" "$analysis_manifest=$analysis_hash" "$exports_manifest=$exports_hash")

unsigned_receipt="$logs_root/fresh-clone-unsigned.json"
node --input-type=module - "${arguments[@]}" >"$unsigned_receipt" <<'NODE'
const [
  sourceCommit, cloneCommit, completedAt, verifierSha256,
  nodeVersion, npmVersion, pythonVersion, ...tail
] = process.argv.slice(2);
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
  schemaVersion: 2,
  status: "pass",
  sourceCommit,
  cloneCommit,
  completedAt,
  verifierSha256,
  runtimes: { node: nodeVersion, npm: npmVersion, python: pythonVersion },
  checks,
  artifacts,
})}\n`);
NODE

receipt_file="$logs_root/fresh-clone.json"
node "$SOURCE_PROJECT_ROOT/scripts/create-fresh-clone-receipt.mjs" \
  "$unsigned_receipt" \
  "$SOURCE_PROJECT_ROOT/var/operations/validation-attestation-private.pem" \
  >"$receipt_file"

node --input-type=module - \
  "$receipt_file" "$clone_root" "$SOURCE_PROJECT_ROOT" "$receipt_destination" \
  "$SOURCE_PROJECT_ROOT/ops/validation-attestation-public.pem" <<'NODE'
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const [receiptPath, cloneRoot, sourceRoot, requestedDestination, publicKeyPath] = process.argv.slice(2);
const value = JSON.parse(readFileSync(receiptPath, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const exactKeys = (object, keys) => Object.keys(object).sort().join("\0") === [...keys].sort().join("\0");
if (!exactKeys(value, [
  "schemaVersion", "status", "sourceCommit", "cloneCommit", "completedAt",
  "verifierSha256", "runtimes", "checks", "artifacts", "attestation",
])
  || value.schemaVersion !== 2 || value.status !== "pass"
  || !/^[a-f0-9]{40}$/.test(value.sourceCommit) || !/^[a-f0-9]{40}$/.test(value.cloneCommit)
  || !/^[a-f0-9]{64}$/.test(value.verifierSha256) || /^0+$/.test(value.verifierSha256)
  || !/^v24\./.test(value.runtimes?.node) || !/^11\./.test(value.runtimes?.npm)) {
  throw new Error("fresh-clone receipt failed strict top-level validation");
}
const verifier = createHash("sha256");
verifier.update("ops/verify-fresh-clone.sh\0");
verifier.update(readFileSync(resolve(cloneRoot, "ops/verify-fresh-clone.sh")));
verifier.update("\0scripts/create-fresh-clone-receipt.mjs\0");
verifier.update(readFileSync(resolve(cloneRoot, "scripts/create-fresh-clone-receipt.mjs")));
if (verifier.digest("hex") !== value.verifierSha256) {
  throw new Error("fresh-clone verifier hash is invalid");
}
const canonicalValue = (input) => {
  if (Array.isArray(input)) return input.map(canonicalValue);
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return input;
};
const { attestation, ...payload } = value;
const canonical = JSON.stringify(canonicalValue(payload));
const publicKey = createPublicKey(readFileSync(publicKeyPath));
const keyId = createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
if (!exactKeys(attestation, ["algorithm", "keyId", "payloadSha256", "signature"])
  || attestation.algorithm !== "ed25519" || attestation.keyId !== keyId
  || attestation.payloadSha256 !== createHash("sha256").update(canonical).digest("hex")
  || !verify(null, Buffer.from(canonical), publicKey, Buffer.from(attestation.signature, "base64"))) {
  throw new Error("fresh-clone receipt signature is invalid");
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
