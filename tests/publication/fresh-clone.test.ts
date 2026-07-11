import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("fresh-clone verifier", () => {
  it("uses a disposable clone with credential-free offline commands", async () => {
    const script = await readFile(new URL("../../ops/verify-fresh-clone.sh", import.meta.url), "utf8");

    expect(script).toContain("git clone --no-local");
    expect(script.indexOf('sanitize_fresh_clone_environment "$home_root"')).toBeLessThan(script.indexOf("git clone --no-local"));
    expect(script).toMatch(/npm.*11/u);
    expect(script).toContain("fresh-clone-environment.sh");
    expect(script).toContain("DATABASE_PATH=var/acceptance/precos.sqlite");
    expect(script).toContain("npm run audit:publication -- --json");
    expect(script).toContain("npm run analysis");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(script).toContain("*.sqlite-wal");
    expect(script).toContain("*.sqlite-shm");
    expect(script).toContain("browser-profile");
    expect(script).toContain("var/acceptance");
    expect(script).toContain("manifest.json");
    expect(script).toContain("new Date().toISOString()");
    expect(script).not.toContain("date -u +%Y-%m-%dT%H:%M:%S.%3NZ");
    expect(script).not.toContain('analysis_latest="analysis/output/latest.json"');
    expect(script).not.toContain("systemctl --user enable");
  });

  it("behaviorally removes hostile inherited timer, credential, and runtime overrides", () => {
    const helper = resolve("ops/fresh-clone-environment.sh");
    const output = execFileSync("bash", ["-c", [
      'source "$1"',
      'sanitize_fresh_clone_environment "/tmp/isolated-home"',
      'for name in OPENAI_API_KEY CODEX_API_KEY NTFY_TOPIC LIVE_OPENAI INSTALL_TIMERS SYSTEMD_UNIT_DIR PRECOS_SCHEDULE_SOURCE ANALYSIS_VENV ANALYSIS_TEST_ROOT PLAYWRIGHT_BROWSERS_PATH VIRTUAL_ENV PYTHONPATH NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG npm_config_userconfig; do [[ -z "${!name+x}" ]] || exit 41; done',
      'printf "%s\\n" "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"',
    ].join("\n"), "bash", helper], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "must-disappear",
        CODEX_API_KEY: "must-disappear",
        NTFY_TOPIC: "must-disappear",
        LIVE_OPENAI: "1",
        INSTALL_TIMERS: "1",
        SYSTEMD_UNIT_DIR: "/tmp/host-units",
        PRECOS_SCHEDULE_SOURCE: "systemd-timer",
        ANALYSIS_VENV: "/tmp/private-venv",
        ANALYSIS_TEST_ROOT: "/tmp/private-analysis",
        PLAYWRIGHT_BROWSERS_PATH: "/tmp/private-browser",
        VIRTUAL_ENV: "/tmp/private-python",
        PYTHONPATH: "/tmp/private-modules",
        NPM_TOKEN: "must-disappear",
        NODE_AUTH_TOKEN: "must-disappear",
        NPM_CONFIG_USERCONFIG: "/tmp/private-npmrc",
        npm_config_userconfig: "/tmp/private-npmrc-lower",
      },
    }).trim().split("\n");
    expect(output).toEqual([
      "/tmp/isolated-home",
      "/tmp/isolated-home/.config",
      "/tmp/isolated-home/.cache",
      "/tmp/isolated-home/.local/share",
      "/tmp/isolated-home/.local/state",
    ]);
  });
});
