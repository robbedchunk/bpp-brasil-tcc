#!/usr/bin/env bash

# This file is sourced by setup.sh so the pinned Node path remains exported.
# It intentionally performs no work until bootstrap_runtime is called.

bootstrap_apt_dependencies() {
  local missing=0 command
  for command in curl git git-lfs python3 sqlite3 xz; do
    command -v "$command" >/dev/null 2>&1 || missing=1
  done
  if [[ "$missing" == "0" ]] \
    && python3 -c 'import sys, venv; raise SystemExit(sys.version_info < (3, 11))' 2>/dev/null; then
    return
  fi
  if ! command -v apt-get >/dev/null 2>&1 || ! command -v sudo >/dev/null 2>&1; then
    printf 'runtime-bootstrap: Debian/Ubuntu apt and sudo are required to install missing system packages.\n' >&2
    return 1
  fi
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git git-lfs python3 python3-venv sqlite3 tzdata xz-utils
  python3 -c 'import sys, venv; raise SystemExit(sys.version_info < (3, 11))'
}

bootstrap_timezone() {
  local timezone=""
  if command -v timedatectl >/dev/null 2>&1; then
    timezone="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
  elif [[ -f /etc/timezone ]]; then
    timezone="$(tr -d '[:space:]' < /etc/timezone)"
  fi
  [[ "$timezone" == "America/Sao_Paulo" ]] && return
  if ! command -v sudo >/dev/null 2>&1; then
    printf 'runtime-bootstrap: sudo is required to set America/Sao_Paulo.\n' >&2
    return 1
  fi
  if command -v timedatectl >/dev/null 2>&1; then
    sudo -n timedatectl set-timezone America/Sao_Paulo
  else
    sudo -n ln -sfn /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime
    printf 'America/Sao_Paulo\n' | sudo -n tee /etc/timezone >/dev/null
  fi
}

bootstrap_node_runtime() {
  if command -v node >/dev/null 2>&1 \
    && [[ "$(node -p 'process.versions.node.split(`.`)[0]' 2>/dev/null)" == "24" ]] \
    && command -v npm >/dev/null 2>&1 \
    && [[ "$(npm --version 2>/dev/null | cut -d. -f1)" == "11" ]]; then
    return
  fi

  # shellcheck source=ops/runtime-versions.env
  source "$PROJECT_ROOT/ops/runtime-versions.env"
  local architecture archive base target temporary expected actual
  case "$(uname -m)" in
    x86_64) architecture=x64 ;;
    aarch64|arm64) architecture=arm64 ;;
    *) printf 'runtime-bootstrap: unsupported Node architecture: %s\n' "$(uname -m)" >&2; return 1 ;;
  esac
  archive="node-v${NODE_VERSION}-linux-${architecture}.tar.xz"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  target="$HOME/.local/share/precos/runtime/node-v${NODE_VERSION}-linux-${architecture}"
  if [[ ! -x "$target/bin/node" ]]; then
    temporary="$(mktemp -d)"
    if ! curl --fail --location --proto '=https' --tlsv1.2 \
      --output "$temporary/$archive" "$base/$archive" \
      || ! curl --fail --location --proto '=https' --tlsv1.2 \
        --output "$temporary/SHASUMS256.txt" "$base/SHASUMS256.txt"; then
      rm -rf -- "$temporary"
      return 1
    fi
    expected="$(awk -v archive="$archive" '$2 == archive { print $1 }' "$temporary/SHASUMS256.txt")"
    actual="$(sha256sum "$temporary/$archive" | cut -d' ' -f1)"
    if [[ ! "$expected" =~ ^[a-f0-9]{64}$ || "$actual" != "$expected" ]]; then
      rm -rf -- "$temporary"
      printf 'runtime-bootstrap: official Node archive checksum mismatch.\n' >&2
      return 1
    fi
    tar -xJf "$temporary/$archive" -C "$temporary"
    install -d -m 0700 "$(dirname "$target")"
    if ! mv -- "$temporary/node-v${NODE_VERSION}-linux-${architecture}" "$target"; then
      rm -rf -- "$temporary"
      return 1
    fi
    rm -rf -- "$temporary"
  fi
  export PATH="$target/bin:$PATH"
  if [[ "$(npm --version | cut -d. -f1)" != "11" || "$(npm --version)" != "$NPM_VERSION" ]]; then
    npm install --global --no-audit --no-fund "npm@$NPM_VERSION"
  fi
  [[ "$(node -p 'process.versions.node.split(`.`)[0]')" == "24" ]]
  [[ "$(npm --version | cut -d. -f1)" == "11" ]]
}

bootstrap_runtime() {
  bootstrap_apt_dependencies
  bootstrap_timezone
  bootstrap_node_runtime
  command -v sqlite3 >/dev/null
  python3 -c 'import sys, venv; raise SystemExit(sys.version_info < (3, 11))'
}
