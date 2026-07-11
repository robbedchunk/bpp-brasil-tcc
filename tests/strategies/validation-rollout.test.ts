import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeValidationRollout,
  type ValidationRolloutOptions,
} from "../../scripts/validate-strategies.js";
import { openDatabase } from "../../src/db/database.js";
import { upsertDiscoveredProduct } from "../../src/db/repositories.js";
import {
  loadRetailerConfigs,
  registerRetailerConfigs,
  type RetailerConfig,
} from "../../src/retailers/config.js";
import type { ProductRef } from "../../src/strategies/types.js";
import {
  attestStrategyValidationEvidence,
  evidenceValueSha256,
  readTrustedValidatorArtifactSha256,
  strategyEvidenceSha256,
  validationReceiptSha256,
  validationRefSha256,
  validationSampleSetSha256,
  type StrategyValidationEvidence,
} from "../../src/strategies/validation-evidence.js";

const directories: string[] = [];
const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function seed(
  database: ReturnType<typeof openDatabase>,
  retailer: RetailerConfig,
  refs: readonly ProductRef[],
): void {
  database.prepare(
    `INSERT INTO retailers
       (id, name, base_url, cep, platform_hint, domains_json, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    retailer.id,
    retailer.name,
    retailer.baseUrl,
    retailer.cep,
    "test",
    JSON.stringify(retailer.allowedDomains),
  );
  refs.forEach((ref, index) => {
    upsertDiscoveredProduct(
      database,
      retailer.id,
      ref,
      new Date(Date.UTC(2026, 6, 11, 7, 0, index)).toISOString(),
    );
  });
}

function trustedReceipt(input: {
  config: RetailerConfig;
  purpose: "discovery" | "extraction";
  refs: readonly ProductRef[];
  privateKey: KeyObject;
  artifactSha256: string;
  valid?: number;
}): StrategyValidationEvidence {
  const valid = input.valid ?? 30;
  const samples = input.refs.map((ref, index) => {
    const request = {
      method: "GET" as const,
      url: ref.canonicalUrl,
      bodySha256: null,
    };
    const outcome = index < valid
      ? {
          status: "valid" as const,
          fields: input.purpose === "extraction"
            ? {
                title: `Rollout product ${index}`,
                brand: "Fixture",
                price: 10 + index,
                promoPrice: null,
                unit: "1 kg",
                available: true,
              }
            : null,
        }
      : {
          status: "invalid" as const,
          failure: {
            category: "missing-fields" as const,
            message: "fixture challenge reference was not found",
            responded: true,
            statusCode: 200,
          },
        };
    return {
      ordinal: index + 1,
      startedOffsetMs: index * 500,
      durationMs: 10,
      ref,
      refSha256: validationRefSha256(ref),
      request,
      requestSha256: evidenceValueSha256(request),
      response: {
        finalUrl: ref.canonicalUrl,
        statusCode: 200,
        contentType: "application/json",
        bodyBytes: 100,
        bodySha256: evidenceValueSha256({ purpose: input.purpose, index }),
      },
      outcome,
      outcomeSha256: evidenceValueSha256(outcome),
      validatedFacts: {
        returnedProductId: input.purpose === "extraction" && index < valid
          ? ref.externalId
          : null,
        catalogSellerId: null,
        catalogSellerMatchCount: null,
      },
    };
  });
  const elapsedMs = 29 * 500 + 10;
  const validatedAt = input.purpose === "discovery"
    ? "2026-07-11T08:00:00.000Z"
    : "2026-07-11T08:01:00.000Z";
  return attestStrategyValidationEvidence({
    schemaVersion: 2,
    retailerId: input.config.id,
    purpose: input.purpose,
    strategyVersion: input.config.strategyVersions[input.purpose],
    strategySha256: strategyEvidenceSha256(input.config[input.purpose]),
    validatedAt,
    executor: {
      program: "scripts/validate-strategies.ts",
      version: 1,
      mode: "trusted-live-host",
      runtime: "node-v24.18.0",
      sourceCommit: "f".repeat(40),
      playwrightVersion: "1.61.1",
      chromiumVersion: "Chromium fixture",
      artifactSha256: input.artifactSha256,
      challengeAlgorithm: "active-in-scope-category-url-bucket-round-robin-v1",
      sequentialPacingMs: 500,
      timeoutMs: 15_000,
      maxBodyBytes: 2_000_000,
      startedAt: new Date(Date.parse(validatedAt) - elapsedMs).toISOString(),
      finishedAt: validatedAt,
      elapsedMs,
      requestHeadersStored: false,
      responseBodiesStored: false,
    },
    attempted: 30,
    valid,
    score: valid / 30,
    activatable: valid >= 27,
    sampleSetSha256: validationSampleSetSha256(samples),
    samples,
  }, input.privateKey);
}

async function fixture(options: {
  validationSuccesses?: number;
  insideProject?: boolean;
  purposes?: Array<"discovery" | "extraction">;
} = {}): Promise<{
  database: ReturnType<typeof openDatabase>;
  configDirectory: string;
  outputDirectory: string;
  loadConfig: () => RetailerConfig;
  baseOptions: Omit<ValidationRolloutOptions, "configs" | "phaseHook">;
  validationCalls: () => number;
  activationCalls: () => number;
}> {
  const root = await mkdtemp(join(
    options.insideProject === true ? process.cwd() : tmpdir(),
    ".validation-rollout-",
  ));
  directories.push(root);
  const configDirectory = join(root, "retailers");
  const outputDirectory = join(root, "data/validation");
  await mkdir(configDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "extra-mercado.json"),
    await readFile("retailers/extra-mercado.json"),
  );
  const loadConfig = (): RetailerConfig => {
    const loaded = loadRetailerConfigs(configDirectory)[0];
    if (loaded === undefined) throw new Error("Missing rollout fixture config");
    return loaded;
  };
  const database = openDatabase(":memory:");
  databases.push(database);
  const initial = loadConfig();
  const refs = Array.from({ length: 30 }, (_value, index) => ({
    canonicalUrl: `https://www.extramercado.com.br/produto/${7_000 + index}/rollout-${index}`,
    externalId: String(7_000 + index),
    sourceCategory: index % 2 === 0 ? "Alimentos" : "Bebidas",
  }));
  seed(database, initial, refs);
  const keys = generateKeyPairSync("ed25519");
  const artifactSha256 = readTrustedValidatorArtifactSha256();
  let validationCalls = 0;
  let activationCalls = 0;
  const baseOptions: Omit<ValidationRolloutOptions, "configs" | "phaseHook"> = {
    purposes: options.purposes ?? ["discovery", "extraction"],
    configsDirectory: configDirectory,
    updateConfig: true,
    activate: true,
    validation: {
      database,
      outputDirectory,
      signingPrivateKey: keys.privateKey,
    },
    testExecutorIdentity: {
      mode: "trusted-live-host",
      runtime: "node-v24.18.0",
      sourceCommit: "f".repeat(40),
      playwrightVersion: "1.61.1",
      chromiumVersion: "Chromium fixture",
      artifactSha256,
    },
    testValidateStrategy: async (config, purpose, challenge) => {
      validationCalls += 1;
      const evidence = trustedReceipt({
        config,
        purpose,
        refs: challenge,
        privateKey: keys.privateKey,
        artifactSha256,
        ...(options.validationSuccesses === undefined
          ? {}
          : { valid: options.validationSuccesses }),
      });
      return {
        path: join(
          outputDirectory,
          ...(evidence.activatable ? [] : ["attempts"]),
          `${config.id}-${purpose}-v${config.strategyVersions[purpose]}.json`,
        ),
        evidence,
      };
    },
    testActivateConfigs: (configs) => {
      activationCalls += 1;
      registerRetailerConfigs(database, configs, {
        projectRoot: root,
        testVerificationPublicKey: keys.publicKey,
      });
    },
  };
  return {
    database,
    configDirectory,
    outputDirectory,
    loadConfig,
    baseOptions,
    validationCalls: () => validationCalls,
    activationCalls: () => activationCalls,
  };
}

function activatedEvidenceCount(database: ReturnType<typeof openDatabase>): number {
  return (database.prepare(
    `SELECT COUNT(*) AS count
     FROM strategies AS strategy
     JOIN strategy_validation_evidence AS evidence ON evidence.strategy_id = strategy.id
     WHERE strategy.active = 1`,
  ).get() as { count: number }).count;
}

function discoveryReceiptName(setup: Awaited<ReturnType<typeof fixture>>): string {
  const config = setup.loadConfig();
  return `${config.id}-discovery-v${config.strategyVersions.discovery}.json`;
}

describe("trusted validation rollout recovery", () => {
  it("resumes after receipt publication without rerunning the signed attempt", async () => {
    const setup = await fixture();
    let interrupted = false;
    await expect(executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
      phaseHook: ({ phase }) => {
        if (phase === "receipt" && !interrupted) {
          interrupted = true;
          throw new Error("crash after receipt");
        }
      },
    })).rejects.toThrow(/crash after receipt/u);
    expect(setup.validationCalls()).toBe(1);

    await executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
    });

    expect(setup.validationCalls()).toBe(2);
    expect(setup.activationCalls()).toBe(1);
    expect(activatedEvidenceCount(setup.database)).toBe(2);
  });

  it("resumes exact config bindings after interruption without replacing receipts", async () => {
    const setup = await fixture();
    await expect(executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
      phaseHook: ({ phase }) => {
        if (phase === "config") throw new Error("crash after config");
      },
    })).rejects.toThrow(/crash after config/u);
    expect(setup.validationCalls()).toBe(2);
    const receipt = await readFile(
      join(setup.outputDirectory, discoveryReceiptName(setup)),
      "utf8",
    );

    await executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
    });

    expect(setup.validationCalls()).toBe(2);
    expect(await readFile(
      join(setup.outputDirectory, discoveryReceiptName(setup)),
      "utf8",
    )).toBe(receipt);
    expect(setup.loadConfig().validation.discovery.receiptSha256)
      .toBe(validationReceiptSha256(JSON.parse(receipt) as StrategyValidationEvidence));
    expect(activatedEvidenceCount(setup.database)).toBe(2);
  });

  it("reconciles an activation committed immediately before interruption", async () => {
    const setup = await fixture();
    await expect(executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
      phaseHook: ({ phase }) => {
        if (phase === "activation") throw new Error("crash after activation");
      },
    })).rejects.toThrow(/crash after activation/u);
    expect(setup.activationCalls()).toBe(1);
    expect(activatedEvidenceCount(setup.database)).toBe(2);

    await executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
    });

    expect(setup.validationCalls()).toBe(2);
    expect(setup.activationCalls()).toBe(1);
    expect(activatedEvidenceCount(setup.database)).toBe(2);
  });

  it("rejects mismatched canonical evidence instead of overwriting it", async () => {
    const setup = await fixture();
    let interrupted = false;
    await expect(executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
      phaseHook: ({ phase }) => {
        if (phase === "receipt" && !interrupted) {
          interrupted = true;
          throw new Error("crash after receipt");
        }
      },
    })).rejects.toThrow(/crash after receipt/u);
    const path = join(setup.outputDirectory, discoveryReceiptName(setup));
    const tampered = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    tampered.validatedAt = "2026-07-11T08:00:01.000Z";
    await writeFile(path, `${JSON.stringify(tampered)}\n`);

    await expect(executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
    })).rejects.toThrow(/does not match the immutable rollout/iu);
    expect(setup.validationCalls()).toBe(1);
    expect(setup.activationCalls()).toBe(0);
  });

  it("durably registers a non-activating trusted-host attempt and reuses it on retry", async () => {
    const setup = await fixture({
      validationSuccesses: 26,
      insideProject: true,
      purposes: ["discovery"],
    });
    await expect(executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
    })).rejects.toThrow(/successor strategy version/iu);
    expect(setup.validationCalls()).toBe(1);
    const attemptPath = join(
      setup.outputDirectory,
      "attempts",
      discoveryReceiptName(setup),
    );
    const manifest = JSON.parse(await readFile(
      join(setup.outputDirectory, "attempts/manifest.json"),
      "utf8",
    )) as { schemaVersion: number; attempts: Array<Record<string, unknown>> };
    expect(JSON.parse(await readFile(attemptPath, "utf8"))).toMatchObject({
      valid: 26,
      score: 26 / 30,
      activatable: false,
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      attempts: [{
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        strategySourceCommit: "f".repeat(40),
      }],
    });
    await expect(readFile(
      join(setup.outputDirectory, discoveryReceiptName(setup)),
    )).rejects.toMatchObject({ code: "ENOENT" });

    await expect(executeValidationRollout({
      ...setup.baseOptions,
      configs: [setup.loadConfig()],
    })).rejects.toThrow(/successor strategy version/iu);
    expect(setup.validationCalls()).toBe(1);
    expect(setup.activationCalls()).toBe(0);
    expect((JSON.parse(await readFile(
      join(setup.outputDirectory, "attempts/manifest.json"),
      "utf8",
    )) as { attempts: unknown[] }).attempts).toHaveLength(1);
  });
});
