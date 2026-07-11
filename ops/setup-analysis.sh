#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIREMENTS="$PROJECT_ROOT/analysis/requirements.txt"
PYTHON="${ANALYSIS_PYTHON:-$(command -v python3)}"
DEFAULT_VENV="$PROJECT_ROOT/var/analysis-venv"
VENV="${ANALYSIS_VENV:-$DEFAULT_VENV}"
MARKER="$VENV/.environment-version"

if [[ "$PYTHON" != /* || "$VENV" != /* ]]; then
  printf 'analysis-setup: Python and virtual-environment paths must be absolute.\n' >&2
  exit 1
fi

PYTHON_VERSION="$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
PYTHON_MAJOR="${PYTHON_VERSION%%.*}"
PYTHON_MINOR="${PYTHON_VERSION#*.}"
if (( PYTHON_MAJOR < 3 || (PYTHON_MAJOR == 3 && PYTHON_MINOR < 11) )); then
  printf 'analysis-setup: Python >=3.11 is required.\n' >&2
  exit 1
fi

REQUIREMENTS_SHA256="$(sha256sum "$REQUIREMENTS" | cut -d' ' -f1)"
EXPECTED_MARKER="$(printf 'requirements_sha256=%s\npython_version=%s\n' \
  "$REQUIREMENTS_SHA256" "$PYTHON_VERSION")"
if [[ -x "$VENV/bin/python" && -f "$MARKER" ]] \
  && [[ "$(cat "$MARKER")" == "$EXPECTED_MARKER" ]]; then
  printf 'analysis-setup: ready.\n'
  exit 0
fi

authorized_test_venv() {
  [[ -n "${ANALYSIS_TEST_ROOT:-}" && "$ANALYSIS_TEST_ROOT" == /* ]] || return 1
  local test_root temporary_root resolved_venv
  test_root="$(realpath -m -- "$ANALYSIS_TEST_ROOT")"
  temporary_root="$(realpath -m -- "${TMPDIR:-/tmp}")"
  resolved_venv="$(realpath -m -- "$VENV")"
  [[ "$test_root" == "$temporary_root"/precos-analysis-* ]] || return 1
  [[ "$resolved_venv" == "$test_root"/* ]]
}

if [[ -e "$VENV" || -L "$VENV" ]]; then
  if [[ "$VENV" != "$DEFAULT_VENV" ]] && ! authorized_test_venv; then
    printf 'analysis-setup: refusing to remove an unauthorized virtual environment.\n' >&2
    exit 1
  fi
  if [[ "$VENV" == "/" || "$VENV" == "" ]]; then
    printf 'analysis-setup: refusing unsafe virtual-environment removal.\n' >&2
    exit 1
  fi
  rm -rf -- "$VENV"
fi

install -d -m 0700 "$(dirname "$VENV")"
"$PYTHON" -m venv "$VENV"
"$VENV/bin/python" -m pip install \
  --disable-pip-version-check \
  --requirement "$REQUIREMENTS"
printf 'requirements_sha256=%s\npython_version=%s\n' \
  "$REQUIREMENTS_SHA256" "$PYTHON_VERSION" > "$MARKER"
chmod 0600 "$MARKER"
printf 'analysis-setup: ready.\n'
