import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("fresh-clone verifier", () => {
  it("uses a disposable clone with credential-free offline commands", async () => {
    const script = await readFile(new URL("../../ops/verify-fresh-clone.sh", import.meta.url), "utf8");
    const packageJson = JSON.parse(await readFile(
      new URL("../../package.json", import.meta.url),
      "utf8",
    )) as { scripts?: Record<string, string> };

    expect(script).toContain("git clone --no-local");
    expect(script).toMatch(/^#!\/usr\/bin\/env -S -i /u);
    expect(script).toContain("/bin/bash --noprofile --norc");
    expect(packageJson.scripts?.["verify:fresh-clone"]).toBe("ops/verify-fresh-clone.sh");
    expect(packageJson.scripts?.["verify:fresh-clone"]).not.toMatch(/^bash\s/u);
    expect(script.indexOf('sanitize_fresh_clone_environment "$home_root"')).toBeLessThan(script.indexOf("git clone --no-local"));
    expect(script).toMatch(/npm.*11/u);
    expect(script).toContain("fresh-clone-environment.sh");
    expect(script).toContain("DATABASE_PATH=var/acceptance/precos.sqlite");
    expect(script).toContain("npm run audit:publication -- --json --implementation-cut");
    expect(script).toContain("resolve_evaluated_commit");
    for (const path of [
      "data/acceptance/acceptance.json",
      "data/acceptance/evidence/alert-drill.json",
      "data/acceptance/evidence/backup-drill.json",
      "data/acceptance/evidence/fresh-clone.json",
      "data/acceptance/evidence/healing-sabotage-drill.json",
      "docs/acceptance-report.md",
    ]) expect(script).toContain(path);
    expect(script).toContain("classification-review-v[1-9][0-9]*");
    expect(script).toContain("npm run analysis");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(script).toContain("*.sqlite-wal");
    expect(script).toContain("*.sqlite-shm");
    expect(script).toContain("browser-profile");
    expect(script).toContain("var/acceptance");
    expect(script).toContain("manifest.json");
    expect(script).toContain("new Date().toISOString()");
    expect(script).toContain("create-fresh-clone-receipt.mjs");
    expect(script).toContain("validation-attestation-private.pem");
    expect(script).toContain("validation-attestation-public.pem");
    expect(script).toContain("verifierSha256");
    expect(script).toContain("schemaVersion: 2");
    expect(script).not.toContain("date -u +%Y-%m-%dT%H:%M:%S.%3NZ");
    expect(script).not.toContain('analysis_latest="analysis/output/latest.json"');
    expect(script).not.toContain("systemctl --user enable");
  });

  it("behaviorally removes hostile inherited timer, credential, and runtime overrides", () => {
    const helper = resolve("ops/fresh-clone-environment.sh");
    const output = execFileSync("bash", ["-c", [
      'source "$1"',
      'sanitize_fresh_clone_environment "/tmp/isolated-home"',
      'for name in OPENAI_API_KEY CODEX_API_KEY NTFY_TOPIC LIVE_OPENAI INSTALL_TIMERS SYSTEMD_UNIT_DIR PRECOS_SCHEDULE_SOURCE ANALYSIS_VENV ANALYSIS_TEST_ROOT PLAYWRIGHT_BROWSERS_PATH VIRTUAL_ENV PYTHONPATH NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_USERCONFIG npm_config_userconfig NODE_OPTIONS NODE_PATH BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT; do [[ -z "${!name+x}" ]] || exit 41; done',
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
        NODE_OPTIONS: "--require=/tmp/hostile-preload.cjs",
        NODE_PATH: "/tmp/private-node-modules",
        ENV: "/tmp/hostile-sh-env",
        LD_LIBRARY_PATH: "/tmp/private-libraries",
        GIT_CONFIG_GLOBAL: "/tmp/private-gitconfig",
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

  it("clears BASH_ENV before the verifier interpreter starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "precos-fresh-clone-entry-"));
    const bashEnvironment = join(root, "hostile-bash-env.sh");
    const marker = join(root, "executed-before-sanitization");
    await writeFile(
      bashEnvironment,
      'printf "BASH_ENV executed\\n" > "$HOSTILE_BASH_ENV_MARKER"\n',
      { mode: 0o600 },
    );
    try {
      const result = spawnSync(resolve("ops/verify-fresh-clone.sh"), ["--invalid"], {
        encoding: "utf8",
        env: {
          ...process.env,
          BASH_ENV: bashEnvironment,
          HOSTILE_BASH_ENV_MARKER: marker,
          PATH: root,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage:");
      expect(result.stderr).not.toContain("BASH_ENV executed");
      expect(existsSync(marker)).toBe(false);

      const npmResult = spawnSync("npm", ["run", "verify:fresh-clone", "--", "--invalid"], {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          BASH_ENV: bashEnvironment,
          HOSTILE_BASH_ENV_MARKER: marker,
        },
      });
      expect(npmResult.status).toBe(2);
      expect(npmResult.stderr).toContain("usage:");
      expect(npmResult.stderr).not.toContain("BASH_ENV executed");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
