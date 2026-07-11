import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
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

import {
  parseArguments,
  validatePlannedReceipt,
} from "../../scripts/apply-validation-successors.mjs";
import {
  inspectPlannedConfigs,
  inspectRecoveryConfigs,
  parseRecoveryPlan,
  preparedConfig,
  recoveryOverlayPath,
  sha256,
  valueSha256,
  verifyCleanBuild,
} from "../../scripts/successor-tooling.mjs";
import * as evidenceTools from "../../src/strategies/validation-evidence.js";

const roots: string[] = [];
const projectRoot = resolve(".");
const successorSourceCommit = "00278a685724a7452837204bee321705c2bad506";
const recoverySourceCommit = "0b7fdb77d6f593e27a66b8aec42d55d849f2e226";
const plan = JSON.parse(readFileSync("data/validation/successor-plans.json", "utf8")) as {
  plans: Array<{
    retailerId: string;
    purpose: "discovery" | "extraction";
    fromVersion: number;
    toVersion: number;
  }>;
};

function recoveryFixture(): { root: string; recovery: ReturnType<typeof parseRecoveryPlan> } {
  const root = mkdtempSync(join(tmpdir(), "validation-recovery-"));
  roots.push(root);
  mkdirSync(join(root, "data/validation/candidates"), { recursive: true });
  mkdirSync(join(root, "retailers"), { recursive: true });
  const definitions = [
    { retailerId: "carrefour", purpose: "extraction", activeVersion: 5, failedVersion: 6, toVersion: 7 },
    { retailerId: "extra-mercado", purpose: "discovery", activeVersion: 3, failedVersion: 4, toVersion: 5 },
  ] as const;
  const entries = definitions.map((definition) => {
    const config = JSON.parse(execFileSync(
      "git",
      ["show", `${recoverySourceCommit}:retailers/${definition.retailerId}.json`],
      { cwd: projectRoot, encoding: "utf8" },
    ));
    writeFileSync(
      join(root, `retailers/${definition.retailerId}.json`),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    const candidate = structuredClone(config[definition.purpose]);
    candidate.allowedDomains = [...candidate.allowedDomains, `recovery-${definition.retailerId}.invalid`];
    const candidatePath = `data/validation/candidates/${definition.retailerId}-${definition.purpose}-v${definition.toVersion}.json`;
    const candidateRaw = `${JSON.stringify(candidate, null, 2)}\n`;
    writeFileSync(join(root, candidatePath), candidateRaw);
    const attemptPath = `data/validation/attempts/${definition.retailerId}-${definition.purpose}-v${definition.failedVersion}.json`;
    const attempt = JSON.parse(readFileSync(join(projectRoot, attemptPath), "utf8"));
    const manifest = JSON.parse(readFileSync(
      join(projectRoot, "data/validation/attempts/manifest.json"),
      "utf8",
    ));
    const manifestEntry = manifest.attempts.find((item: { path: string }) => item.path === attemptPath);
    return {
      ...definition,
      activeStrategySha256: attempt.strategySha256,
      failedStrategySha256: attempt.strategySha256,
      candidatePath,
      candidateFileSha256: sha256(candidateRaw),
      strategySha256: valueSha256(candidate),
      failedAttemptPath: attemptPath,
      failedAttemptFileSha256: manifestEntry.fileSha256,
      failedAttemptReceiptSha256: manifestEntry.receiptSha256,
      failedAttemptSampleSetSha256: attempt.sampleSetSha256,
      reason: "Burned predecessor recovery fixture.",
      ...(definition.retailerId === "carrefour" ? {
        configPatch: {
          cep: "04601-000",
          platformEvidence: {
            ...config.platformEvidence,
            observedAt: "2026-07-11T14:34:34.000Z",
            notes: "Recovery coverage fixture.",
          },
          storeMapping: {
            storeId: "carrefourbrfood442",
            erpCode: null,
            evidenceUrl: "https://mercado.carrefour.com.br/?postalCode=04601000",
          },
        },
      } : {}),
    };
  });
  const recovery = parseRecoveryPlan({
    schemaVersion: 1,
    parent: {
      sourceCommit: successorSourceCommit,
      planPath: "data/validation/successor-plans.json",
      planFileSha256: sha256(readFileSync(join(projectRoot, "data/validation/successor-plans.json"))),
      validatorArtifactSha256: "946e7fea7c29e788c0616bc62164e60b61d02f40c543acd872b1f430d5d710d3",
      attestationKeyId: "b9583b0ea8efeb057d8fbbb01d7028063857dad6461354af7265e061faef022a",
    },
    plans: entries,
  });
  return { root, recovery };
}

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
    const config = JSON.parse(execFileSync(
      "git",
      ["show", `${successorSourceCommit}:retailers/${retailerId}.json`],
      { cwd: projectRoot, encoding: "utf8" },
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
  it("requires an explicit flag before enabling partial application", () => {
    expect(parseArguments(["--root", projectRoot])).toMatchObject({ allowPartial: false });
    expect(parseArguments(["--allow-partial", "--root", projectRoot])).toMatchObject({
      allowPartial: true,
    });
    expect(parseArguments(["--recovery", "--root", projectRoot])).toMatchObject({
      recovery: true,
      allowPartial: false,
    });
  });

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

  it("accepts an already-applied config state only in partial inspection mode", () => {
    const root = fixture();
    const entry = plan.plans.find((candidate) =>
      candidate.retailerId === "carrefour" && candidate.purpose === "discovery");
    expect(entry).toBeDefined();
    const configPath = join(root, "retailers/carrefour.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.strategyVersions.discovery = entry!.toVersion;
    config.validation.discovery.receiptPath =
      `data/validation/carrefour-discovery-v${entry!.toVersion}.json`;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    expect(() => inspectPlannedConfigs(root, plan.plans, { requireTracked: false }))
      .toThrow(/must be version/iu);
    expect(inspectPlannedConfigs(root, plan.plans, {
      allowApplied: true,
      requireTracked: false,
    }).find(({ retailerId }) => retailerId === "carrefour")?.config.strategyVersions.discovery)
      .toBe(entry!.toVersion);
  });

  it("requires an exact signed below-gate manifest entry for every partial skip", () => {
    const entry = plan.plans.find((candidate) =>
      candidate.retailerId === "carrefour" && candidate.purpose === "extraction");
    expect(entry).toBeDefined();
    const receiptName = `carrefour-extraction-v${entry!.toVersion}.json`;
    const sourceReceipt = join(projectRoot, "data/validation/attempts", receiptName);
    const evidence = JSON.parse(readFileSync(sourceReceipt, "utf8"));
    const sourceManifest = JSON.parse(readFileSync(
      join(projectRoot, "data/validation/attempts/manifest.json"),
      "utf8",
    ));
    const manifestEntry = sourceManifest.attempts.find((candidate: { path: string }) =>
      candidate.path === `data/validation/attempts/${receiptName}`);
    expect(manifestEntry).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "validation-partial-receipt-"));
    roots.push(root);
    mkdirSync(join(root, "data/validation/attempts"), { recursive: true });
    copyFileSync(sourceReceipt, join(root, "data/validation/attempts", receiptName));
    writeFileSync(join(root, "data/validation/attempts/manifest.json"), `${JSON.stringify({
      schemaVersion: 1,
      attempts: [manifestEntry],
    }, null, 2)}\n`);
    const strategy = JSON.parse(execFileSync(
      "git",
      ["show", `${successorSourceCommit}:retailers/carrefour.json`],
      { cwd: projectRoot, encoding: "utf8" },
    )).extraction;
    const trackedPublicKey = createPublicKey(readFileSync(
      join(projectRoot, "ops/validation-attestation-public.pem"),
    ));
    const input = {
      root,
      plan: entry,
      strategy,
      challenge: evidence.samples.map((sample: { ref: unknown }) => sample.ref),
      trackedPublicKey,
      evidenceTools,
      sourceCommit: evidence.executor.sourceCommit,
      expectedValidator: evidence.executor.artifactSha256,
      outcome: "failure",
      now: Date.parse(evidence.validatedAt) + 1,
    } as const;
    expect(validatePlannedReceipt(input).evidence).toMatchObject({
      attempted: 30,
      valid: 26,
      activatable: false,
    });

    const tampered = JSON.parse(readFileSync(
      join(root, "data/validation/attempts/manifest.json"),
      "utf8",
    ));
    tampered.attempts[0].fileSha256 = "0".repeat(64);
    writeFileSync(
      join(root, "data/validation/attempts/manifest.json"),
      `${JSON.stringify(tampered)}\n`,
    );
    expect(() => validatePlannedReceipt(input)).toThrow(/exactly preserved/iu);

    copyFileSync(sourceReceipt, join(root, "data/validation", receiptName));
    expect(() => validatePlannedReceipt({ ...input, outcome: "success" }))
      .toThrow(/trusted rollout/iu);
  });

  it("parses only the exact two burned-version recovery lineages", () => {
    const { recovery } = recoveryFixture();
    expect(recovery.plans.map(({ retailerId, purpose, activeVersion, failedVersion, toVersion }) => ({
      retailerId,
      purpose,
      activeVersion,
      failedVersion,
      toVersion,
    }))).toEqual([
      {
        retailerId: "carrefour",
        purpose: "extraction",
        activeVersion: 5,
        failedVersion: 6,
        toVersion: 7,
      },
      {
        retailerId: "extra-mercado",
        purpose: "discovery",
        activeVersion: 3,
        failedVersion: 4,
        toVersion: 5,
      },
    ]);
    const unchanged = structuredClone(recovery);
    unchanged.plans[0]!.strategySha256 = unchanged.plans[0]!.failedStrategySha256;
    expect(() => parseRecoveryPlan(unchanged)).toThrow(/malformed/iu);
    const badPatch = structuredClone(recovery);
    (badPatch.plans[0]!.configPatch as Record<string, unknown>).forbidden = true;
    expect(() => parseRecoveryPlan(badPatch)).toThrow(/forbidden fields/iu);
  });

  it("builds a fresh digest-namespaced recovery overlay without changing unrelated purposes", () => {
    const { root, recovery } = recoveryFixture();
    const configs = inspectRecoveryConfigs(root, recovery, { requireTracked: false });
    expect(configs).toHaveLength(2);
    const carrefour = configs.find(({ retailerId }) => retailerId === "carrefour")!;
    const prepared = preparedConfig(carrefour);
    expect(prepared.strategyVersions).toEqual({ discovery: 7, extraction: 7 });
    expect(prepared.extraction).toEqual(carrefour.plans[0]!.candidateStrategy);
    expect(prepared.discovery).toEqual(carrefour.config.discovery);
    expect(prepared.validation.discovery).toEqual(carrefour.config.validation.discovery);
    expect(prepared.cep).toBe("04601-000");
    expect(prepared.storeMapping).toMatchObject({ storeId: "carrefourbrfood442" });
    expect(recoveryOverlayPath(root, recovery)).toMatch(
      /var\/validation-recovery-[a-f0-9]{64}$/u,
    );

    const tamperedPath = join(root, carrefour.plans[0]!.candidatePath);
    writeFileSync(tamperedPath, `${readFileSync(tamperedPath, "utf8")}\n`);
    expect(() => inspectRecoveryConfigs(root, recovery, { requireTracked: false }))
      .toThrow(/misbound/iu);
  });
});
