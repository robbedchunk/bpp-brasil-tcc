import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyCleanBuild } from "../../scripts/successor-tooling.mjs";

const roots: string[] = [];
const projectRoot = resolve(".");
const plan = JSON.parse(readFileSync("data/validation/successor-plans.json", "utf8")) as {
  plans: Array<{
    retailerId: string;
    purpose: "discovery" | "extraction";
    fromVersion: number;
    toVersion: number;
  }>;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "validation-successors-"));
  roots.push(root);
  mkdirSync(join(root, "data/validation"), { recursive: true });
  mkdirSync(join(root, "retailers"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(
    join(projectRoot, "data/validation/successor-plans.json"),
    join(root, "data/validation/successor-plans.json"),
  );
  for (const retailerId of new Set(plan.plans.map((entry) => entry.retailerId))) {
    const config = JSON.parse(readFileSync(
      join(projectRoot, `retailers/${retailerId}.json`),
      "utf8",
    ));
    for (const entry of plan.plans.filter((candidate) => candidate.retailerId === retailerId)) {
      config.strategyVersions[entry.purpose] = entry.fromVersion;
      config.validation[entry.purpose].receiptPath =
        `data/validation/${retailerId}-${entry.purpose}-v${entry.fromVersion}.json`;
    }
    writeFileSync(
      join(root, `retailers/${retailerId}.json`),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
  for (const name of [
    "apply-validation-successors.mjs",
    "prepare-validation-successors.mjs",
    "successor-tooling.mjs",
  ]) {
    copyFileSync(join(projectRoot, "scripts", name), join(root, "scripts", name));
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "data/validation/successor-plans.json", "retailers", "scripts"]);
  git(root, [
    "-c",
    "user.name=Validation Test",
    "-c",
    "user.email=validation@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

describe("validation successor preparation", () => {
  it("verifies a clean dist while excluding its build manifest from the artifact walk", () => {
    const root = mkdtempSync(join(tmpdir(), "validation-successor-build-"));
    roots.push(root);
    const validator = Buffer.from("trusted validator fixture\n");
    const validatorSha256 = createHash("sha256").update(validator).digest("hex");
    const files = [{
      path: "scripts/validate-strategies.js",
      sha256: validatorSha256,
      bytes: validator.length,
    }];
    const artifactSetSha256 = createHash("sha256")
      .update(JSON.stringify(files)).digest("hex");
    mkdirSync(join(root, "dist/scripts"), { recursive: true });
    mkdirSync(join(root, "ops"), { recursive: true });
    writeFileSync(join(root, "dist/scripts/validate-strategies.js"), validator);
    writeFileSync(join(root, "ops/validator-bundle.sha256"), `${validatorSha256}\n`);
    writeFileSync(join(root, "dist/build-manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      sourceCommit: "a".repeat(40),
      sourceClean: true,
      artifactSetSha256,
      files,
    })}\n`);

    expect(verifyCleanBuild(root, "a".repeat(40))).toMatchObject({
      expectedValidator: validatorSha256,
    });
  });

  it("creates an exact private +1 overlay and preserves all unrelated metadata", () => {
    const root = fixture();
    const prepareScript = join(root, "scripts/prepare-validation-successors.mjs");
    const result = spawnSync(process.execPath, [prepareScript, "--root", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      event: "validation-successors-prepared",
      retailers: 4,
      strategies: 8,
      directoryMode: "0700",
      fileMode: "0600",
    });

    const overlay = join(root, "var/validation-rollout-configs");
    expect(statSync(overlay).mode & 0o777).toBe(0o700);
    for (const retailerId of new Set(plan.plans.map((entry) => entry.retailerId))) {
      const original = JSON.parse(readFileSync(join(root, `retailers/${retailerId}.json`), "utf8"));
      const preparedPath = join(overlay, `${retailerId}.json`);
      const prepared = JSON.parse(readFileSync(preparedPath, "utf8"));
      expect(statSync(preparedPath).mode & 0o777).toBe(0o600);
      const expected = structuredClone(original);
      for (const entry of plan.plans.filter((candidate) => candidate.retailerId === retailerId)) {
        expected.strategyVersions[entry.purpose] = entry.toVersion;
        expected.validation[entry.purpose].receiptPath =
          `data/validation/${retailerId}-${entry.purpose}-v${entry.toVersion}.json`;
      }
      expect(prepared).toEqual(expected);
    }

    chmodSync(overlay, 0o755);
    const rerun = spawnSync(process.execPath, [prepareScript, "--root", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(statSync(overlay).mode & 0o777).toBe(0o700);
  });

  it("refuses dirty tracked inputs and never overwrites a divergent overlay", () => {
    const root = fixture();
    const prepareScript = join(root, "scripts/prepare-validation-successors.mjs");
    const configPath = join(root, "retailers/carrefour.json");
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n`);
    const dirty = spawnSync(process.execPath, [prepareScript, "--root", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toMatch(/clean trusted implementation surface/u);

    writeFileSync(
      configPath,
      git(root, ["show", "HEAD:retailers/carrefour.json"]) + "\n",
    );
    const prepared = spawnSync(process.execPath, [prepareScript, "--root", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(prepared.status, prepared.stderr).toBe(0);
    const overlayConfig = join(root, "var/validation-rollout-configs/carrefour.json");
    writeFileSync(overlayConfig, "{}\n", { mode: 0o600 });
    const divergent = spawnSync(process.execPath, [prepareScript, "--root", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(divergent.status).not.toBe(0);
    expect(divergent.stderr).toMatch(/overlay differs/u);
    expect(readFileSync(overlayConfig, "utf8")).toBe("{}\n");
  });

  it("rejects an untracked file anywhere in the trusted implementation surface", () => {
    const root = fixture();
    const prepareScript = join(root, "scripts/prepare-validation-successors.mjs");
    const applyScript = join(projectRoot, "scripts/apply-validation-successors.mjs");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/injected.ts"), "export const injected = true;\n");

    const result = spawnSync(process.execPath, [prepareScript, "--root", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/clean trusted implementation surface/u);
    expect(result.stderr).toContain("src/injected.ts");

    const apply = spawnSync(process.execPath, [applyScript, "--root", root], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(apply.status).not.toBe(0);
    expect(apply.stderr).toMatch(/clean trusted implementation surface/u);
    expect(apply.stderr).toContain("src/injected.ts");
  });
});
