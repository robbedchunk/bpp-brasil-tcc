#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
source "$PROJECT_ROOT/ops/lib.sh"
select_node_24 weekly-index

EXPORT_ROOT="${INDEX_EXPORT_ROOT:-$PROJECT_ROOT/data/exports}"
ANALYSIS_ROOT="${ANALYSIS_OUTPUT_ROOT:-$PROJECT_ROOT/analysis/output}"
PYTHON="${ANALYSIS_VENV:-$PROJECT_ROOT/var/analysis-venv}/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  printf 'weekly-index: analysis environment is absent; run ops/setup-analysis.sh.\n' >&2
  exit 1
fi

install -d -m 0700 "$PROJECT_ROOT/var" "$PROJECT_ROOT/var/matplotlib"
INDEX_SUMMARY="$(mktemp "$PROJECT_ROOT/var/index-summary.XXXXXX")"
ANALYSIS_SUMMARY="$(mktemp "$PROJECT_ROOT/var/analysis-summary.XXXXXX")"
trap 'rm -f "$INDEX_SUMMARY" "$ANALYSIS_SUMMARY"' EXIT

node "$PROJECT_ROOT/dist/cli.js" index \
  --export \
  --classification-version 1 \
  --output "$EXPORT_ROOT" \
  --json > "$INDEX_SUMMARY"
MPLCONFIGDIR="$PROJECT_ROOT/var/matplotlib" \
  "$PYTHON" "$PROJECT_ROOT/analysis/generate.py" \
  --input "$EXPORT_ROOT" \
  --output "$ANALYSIS_ROOT" > "$ANALYSIS_SUMMARY"

node --input-type=module - "$INDEX_SUMMARY" "$ANALYSIS_SUMMARY" <<'NODE'
import { readFileSync } from "node:fs";

const [indexPath, analysisPath] = process.argv.slice(2);
if (indexPath === undefined || analysisPath === undefined) {
  throw new Error("weekly-index summary paths are missing");
}
const index = JSON.parse(readFileSync(indexPath, "utf8"));
const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
process.stdout.write(`${JSON.stringify({ status: analysis.status, index, analysis })}\n`);
NODE
