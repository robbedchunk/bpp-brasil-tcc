#!/usr/bin/env bash

# Scrub every production/runtime override that could make a disposable clone
# mutate host state or reuse private credentials and analysis environments.
sanitize_fresh_clone_environment() {
  local isolated_home="$1"
  unset OPENAI_API_KEY CODEX_API_KEY NTFY_TOPIC LIVE_OPENAI
  unset INSTALL_TIMERS SYSTEMD_UNIT_DIR PRECOS_SCHEDULE_SOURCE
  unset ANALYSIS_VENV ANALYSIS_TEST_ROOT PLAYWRIGHT_BROWSERS_PATH VIRTUAL_ENV PYTHONPATH
  unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG npm_config_userconfig
  export HOME="$isolated_home"
  export XDG_CONFIG_HOME="$isolated_home/.config"
  export XDG_CACHE_HOME="$isolated_home/.cache"
  export XDG_DATA_HOME="$isolated_home/.local/share"
  export XDG_STATE_HOME="$isolated_home/.local/state"
}
