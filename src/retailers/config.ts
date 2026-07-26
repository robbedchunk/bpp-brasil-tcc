import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type Database from "better-sqlite3";
import type { KeyObject } from "node:crypto";
import { z } from "zod";

import { executeExtraction } from "../collection/executor.js";
import {
  DiscoveryStrategySchema,
  ExtractionStrategySchema,
  type DiscoveryStrategy,
  type ExtractionStrategy,
} from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import { selectStrategyValidationChallenge } from "../strategies/validation-challenge.js";
import {
  canonicalEvidenceJson,
  readValidationVerificationPublicKey,
  readTrustedValidatorArtifactSha256,
  validateStrategyEvidence,
  validationReceiptSha256,
  type StrategyValidationEvidence,
} from "../strategies/validation-evidence.js";
import { insertVerifiedStrategyValidationEvidence } from "../db/database.js";

const FixtureProvenanceSchema = z.object({
  path: z.string().min(1),
  sourceUrl: z.string().url(),
  capturedAt: z.string().datetime(),
  redactions: z.array(z.string().min(1)).min(1),
  synthetic: z.boolean(),
}).strict();

const ValidationSchema = z.object({
  externallyValidated: z.boolean(),
  validatedAt: z.string().datetime().nullable(),
  sampleSize: z.number().int().min(0),
  successes: z.number().int().min(0),
  score: z.number().min(0).max(1),
  evidence: z.string().min(1),
  receiptPath: z.string().regex(
    /^data\/validation\/[a-z0-9]+(?:-[a-z0-9]+)*-(?:discovery|extraction)-v\d+\.json$/u,
  ).nullable(),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).strict().superRefine((value, context) => {
  if (value.successes > value.sampleSize) {
    context.addIssue({ code: "custom", message: "successes cannot exceed sampleSize" });
  }
  const expected = value.sampleSize === 0 ? 0 : value.successes / value.sampleSize;
  if (Math.abs(value.score - expected) > Number.EPSILON) {
    context.addIssue({ code: "custom", message: "score must equal successes/sampleSize" });
  }
  if (value.externallyValidated && value.validatedAt === null) {
    context.addIssue({
      code: "custom",
      path: ["validatedAt"],
      message: "Externally validated evidence requires a validation timestamp",
    });
  }
});

export const RetailerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  allowedDomains: z.array(z.string().min(1)).min(1),
  cep: z.string().regex(/^\d{5}-\d{3}$/u),
  active: z.boolean(),
  backupRank: z.number().int().positive().nullable(),
  platformEvidence: z.object({
    platform: z.string().min(1),
    observedAt: z.string().datetime(),
    urls: z.array(z.string().url()).min(1),
    notes: z.string().min(1),
  }).strict(),
  storeMapping: z.object({
    storeId: z.string().min(1),
    erpCode: z.string().min(1).nullable(),
    evidenceUrl: z.string().url(),
  }).strict().nullable(),
  seedHints: z.array(z.string().min(1)).min(1),
  politeDelayMs: z.object({
    min: z.number().int().min(200).max(30_000),
    max: z.number().int().min(200).max(30_000),
  }).strict(),
  strategyVersions: z.object({
    discovery: z.number().int().positive(),
    extraction: z.number().int().positive(),
  }).strict(),
  discovery: DiscoveryStrategySchema,
  extraction: ExtractionStrategySchema,
  fixtureRef: z.object({
    canonicalUrl: z.string().url(),
    externalId: z.string().nullable(),
    sourceCategory: z.string().nullable(),
  }).strict(),
  fixtureProvenance: z.array(FixtureProvenanceSchema).min(2),
  validation: z.object({
    discovery: ValidationSchema,
    extraction: ValidationSchema,
  }).strict(),
}).strict().superRefine((config, context) => {
  if (config.politeDelayMs.max < config.politeDelayMs.min) {
    context.addIssue({
      code: "custom",
      path: ["politeDelayMs", "max"],
      message: "maximum polite delay must be at least the minimum",
    });
  }
  const strategyDomains = new Set([
    ...config.discovery.allowedDomains,
    ...config.extraction.allowedDomains,
  ]);
  for (const domain of config.allowedDomains) {
    if (!strategyDomains.has(domain)) {
      context.addIssue({
        code: "custom",
        path: ["allowedDomains"],
        message: `Configured domain ${domain} is absent from both strategies`,
      });
    }
  }
  for (const domain of strategyDomains) {
    if (!config.allowedDomains.includes(domain)) {
      context.addIssue({
        code: "custom",
        path: ["allowedDomains"],
        message: `Strategy domain ${domain} is absent from retailer allowedDomains`,
      });
    }
  }
  if (config.active && (["discovery", "extraction"] as const).some((purpose) => {
    const validation = config.validation[purpose];
    return !validation.externallyValidated
      || validation.sampleSize !== 30
      || validation.score < 0.9;
  })) {
    context.addIssue({
      code: "custom",
      path: ["active"],
      message: "Active retailers require an external 30-sample score of at least 0.9",
    });
  }
  for (const purpose of ["discovery", "extraction"] as const) {
    const expectedPath = `data/validation/${config.id}-${purpose}-v${config.strategyVersions[purpose]}.json`;
    const receiptPath = config.validation[purpose].receiptPath;
    if (config.active && receiptPath !== expectedPath) {
      context.addIssue({
        code: "custom",
        path: ["validation", purpose, "receiptPath"],
        message: `Active validation must bind canonical receipt ${expectedPath}`,
      });
    }
  }
  if (
    config.active
    && config.extraction.tier === "api"
    && config.extraction.regionalContext !== undefined
    && config.extraction.regionalContext.catalogSellerId === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["extraction", "regionalContext", "catalogSellerId"],
      message: "Active VTEX regional extraction must bind the validated catalog seller identity",
    });
  }
}).transform((config) => config as typeof config & {
  discovery: DiscoveryStrategy;
  extraction: ExtractionStrategy;
});

export type RetailerConfig = z.output<typeof RetailerConfigSchema>;

export function loadRetailerConfigs(directory: string): RetailerConfig[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const path = resolve(directory, entry.name);
      return RetailerConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export interface FixtureValidationReport {
  activatable: boolean;
  fixtureCount: number;
  extractionOk: boolean;
  reason?: string;
}

const SECRET_PATTERN =
  /(?:set-cookie|authorization|bearer\s|session[_-]?id|storefrontAccessToken|apiToken|PriceToken|geolocationApiKey)/iu;

export async function validateFixtureStrategy(
  config: RetailerConfig,
): Promise<FixtureValidationReport> {
  const fixtures = await Promise.all(config.fixtureProvenance.map(async (provenance) => ({
    provenance,
    body: await readFile(resolve(provenance.path), "utf8"),
  })));
  for (const fixture of fixtures) {
    if (SECRET_PATTERN.test(fixture.body)) {
      return {
        activatable: false,
        fixtureCount: fixtures.length,
        extractionOk: false,
        reason: `Fixture ${fixture.provenance.path} contains a secret-shaped field`,
      };
    }
    if (fixture.provenance.synthetic && !/synthetic/iu.test(fixture.body)) {
      return {
        activatable: false,
        fixtureCount: fixtures.length,
        extractionOk: false,
        reason: `Fixture ${fixture.provenance.path} is not visibly labeled synthetic`,
      };
    }
  }

  const primary = fixtures.find(({ provenance }) => !provenance.synthetic);
  if (primary === undefined) {
    return {
      activatable: false,
      fixtureCount: fixtures.length,
      extractionOk: false,
      reason: "A non-synthetic fixture is required",
    };
  }
  const result = await executeExtraction(config.extraction, config.fixtureRef, {
    fetch: async () => new Response(primary.body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  const extractionOk = result.ok === true;
  return {
    activatable: extractionOk || !config.active,
    fixtureCount: fixtures.length,
    extractionOk,
    ...(extractionOk || !config.active
      ? {}
      : { reason: result.failure?.message ?? "Fixture extraction failed" }),
  };
}

function strategyTier(strategy: DiscoveryStrategy | ExtractionStrategy): number {
  if (strategy.purpose === "discovery") {
    switch (strategy.tier) {
      case "sitemap": return 1;
      case "api": return 2;
      case "dom-crawl": return 3;
      case "script": return 4;
    }
  }
  switch (strategy.tier) {
    case "api": return 1;
    case "embedded-json": return 2;
    case "dom": return 3;
    case "script": return 4;
  }
}

export interface RetailerRegistrationOptions {
  projectRoot?: string;
  readValidationReceipt?: (absolutePath: string) => unknown;
  testVerificationPublicKey?: KeyObject;
  mode?: "activate" | "bootstrap-inactive";
}

/**
 * Persist one immutable inactive config strategy so a bounded candidate run can
 * be audited before external validation. Existing retailer/strategy activation
 * state is deliberately untouched.
 */
export function stageRetailerConfigStrategy(
  database: Database.Database,
  config: RetailerConfig,
  purpose: "discovery" | "extraction",
): {
  id: string;
  retailerId: string;
  purpose: "discovery" | "extraction";
  version: number;
  strategy: DiscoveryStrategy | ExtractionStrategy;
} {
  const strategy = config[purpose];
  const version = config.strategyVersions[purpose];
  const id = `${config.id}-${purpose}-v${version}`;
  const strategyJson = JSON.stringify(strategy);
  const provenance = `retailer config; ${config.validation[purpose].evidence}`;
  const stage = database.transaction(() => {
    database.prepare(
      `INSERT INTO retailers
         (id, name, base_url, cep, platform_hint, domains_json, active,
          degraded, degraded_reason)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         base_url = excluded.base_url,
         cep = excluded.cep,
         platform_hint = excluded.platform_hint,
         domains_json = excluded.domains_json,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(
      config.id,
      config.name,
      config.baseUrl,
      config.cep,
      config.platformEvidence.platform,
      JSON.stringify(config.allowedDomains),
    );
    const existing = database.prepare(
      `SELECT retailer_id, purpose, tier, version, strategy_json, provenance,
              retired_at
       FROM strategies WHERE id = ?`,
    ).get(id) as {
      retailer_id: string;
      purpose: string;
      tier: number;
      version: number;
      strategy_json: string;
      provenance: string;
      retired_at: string | null;
    } | undefined;
    const tier = strategyTier(strategy);
    if (existing !== undefined && (
      existing.retailer_id !== config.id
      || existing.purpose !== purpose
      || existing.tier !== tier
      || existing.version !== version
      || existing.strategy_json !== strategyJson
      || existing.provenance !== provenance
    )) {
      throw new Error(`Strategy ${id} changed immutable fields; create a version bump instead`);
    }
    if (existing?.retired_at !== null && existing?.retired_at !== undefined) {
      throw new Error(`Strategy ${id} is retired; candidate staging requires a successor version`);
    }
    if (existing === undefined) {
      database.prepare(
        `INSERT INTO strategies
         (id, retailer_id, purpose, tier, version, strategy_json, provenance,
          validation_sample_size, validation_successes, validation_rate,
          active, validated_at, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, NULL, NULL)`,
      ).run(id, config.id, purpose, tier, version, strategyJson, provenance);
    }
  });
  stage.immediate();
  return { id, retailerId: config.id, purpose, version, strategy };
}

function authoritativeValidationRefs(
  database: Database.Database,
  retailerId: string,
  includeHistorical = false,
): ProductRef[] {
  return (database.prepare(
    `SELECT canonical_url, retailer_product_id, source_category
     FROM products
     WHERE retailer_id = ?
       AND (? = 1 OR (active = 1 AND in_scope = 1))
     ORDER BY canonical_url`,
  ).all(retailerId, includeHistorical ? 1 : 0) as Array<{
    canonical_url: string;
    retailer_product_id: string | null;
    source_category: string | null;
  }>).map((row) => ({
    canonicalUrl: row.canonical_url,
    externalId: row.retailer_product_id,
    sourceCategory: row.source_category,
  }));
}

function validatedActivationEvidence(
  database: Database.Database,
  config: RetailerConfig,
  purpose: "discovery" | "extraction",
  options: RetailerRegistrationOptions,
  verificationPublicKey: KeyObject,
  allowEmptyTestCatalog: boolean,
): StrategyValidationEvidence | null {
  if (!config.active) return null;
  const validation = config.validation[purpose];
  const receiptPath = validation.receiptPath;
  if (receiptPath === null) {
    throw new Error(`Active ${config.id}/${purpose} has no validation receipt`);
  }
  const absolutePath = resolve(options.projectRoot ?? process.cwd(), receiptPath);
  let input: unknown;
  if (options.readValidationReceipt === undefined) {
    let regularFile = false;
    try {
      regularFile = lstatSync(absolutePath).isFile();
    } catch (error) {
      throw new Error(`Validation receipt is unavailable: ${receiptPath}`, { cause: error });
    }
    if (!regularFile) {
      throw new Error(`Validation receipt is not a regular file: ${receiptPath}`);
    }
    input = JSON.parse(readFileSync(absolutePath, "utf8"));
  } else {
    input = options.readValidationReceipt(absolutePath);
  }
  const expected = {
    retailerId: config.id,
    purpose,
    strategyVersion: config.strategyVersions[purpose],
    strategy: config[purpose],
    verificationPublicKey,
  } as const;
  const identityEvidence = validateStrategyEvidence(input, expected);
  const strategyId = `${config.id}-${purpose}-v${config.strategyVersions[purpose]}`;
  const alreadyBound = database.prepare(
    "SELECT 1 FROM strategy_validation_evidence WHERE strategy_id = ?",
  ).get(strategyId) !== undefined;
  const authoritativeRefs = alreadyBound
    ? authoritativeValidationRefs(database, config.id, true)
    : selectStrategyValidationChallenge(database, config.id, 30);
  if (authoritativeRefs.length < 30 && !allowEmptyTestCatalog) {
    throw new Error(
      `Active ${config.id}/${purpose} requires at least 30 active in-scope catalog references`,
    );
  }
  const evidence = authoritativeRefs.length === 0 && allowEmptyTestCatalog
    ? identityEvidence
    : validateStrategyEvidence(input, {
        ...expected,
        authoritativeRefs,
      });
  if (
    !alreadyBound
    && !allowEmptyTestCatalog
    && canonicalEvidenceJson(evidence.samples.map(({ ref }) => ref))
      !== canonicalEvidenceJson(authoritativeRefs)
  ) {
    throw new Error(
      `Active ${config.id}/${purpose} receipt does not match the independent validation challenge`,
    );
  }
  if (
    !alreadyBound
    && !allowEmptyTestCatalog
    && (
      evidence.executor.artifactSha256 !== readTrustedValidatorArtifactSha256()
      || evidence.executor.challengeAlgorithm
        !== "active-in-scope-category-url-bucket-round-robin-v1"
    )
  ) {
    throw new Error(
      `Active ${config.id}/${purpose} receipt is not bound to the trusted validator artifact`,
    );
  }
  if (
    validation.receiptSha256 === null
    || validation.receiptSha256 !== validationReceiptSha256(evidence)
  ) {
    throw new Error(
      `Validation receipt digest does not match ${config.id}/${purpose}; `
      + `set receiptSha256=${validationReceiptSha256(evidence)}`,
    );
  }
  if (
    evidence.validatedAt !== validation.validatedAt
    || evidence.attempted !== validation.sampleSize
    || evidence.valid !== validation.successes
    || evidence.score !== validation.score
    || evidence.activatable !== true
  ) {
    throw new Error(
      `Validation receipt aggregate does not match ${config.id}/${purpose} activation metadata; `
      + `set validatedAt=${evidence.validatedAt}, sampleSize=${evidence.attempted}, `
      + `successes=${evidence.valid}, and score=${evidence.score}`,
    );
  }
  return evidence;
}

export function registerRetailerConfigs(
  database: Database.Database,
  configs: readonly RetailerConfig[],
  options: RetailerRegistrationOptions = {},
): void {
  const activate = (options.mode ?? "activate") === "activate";
  const requiresKey = activate && configs.some((config) => config.active);
  if (
    options.testVerificationPublicKey !== undefined
    && database.name !== ":memory:"
    && database.name !== ""
  ) {
    throw new Error("A caller-supplied validation key is forbidden for file-backed registration");
  }
  const verificationPublicKey = requiresKey
    ? options.testVerificationPublicKey ?? readValidationVerificationPublicKey(
      new URL("../../ops/validation-attestation-public.pem", import.meta.url).pathname,
    )
    : null;
  const allowEmptyTestCatalog = options.testVerificationPublicKey !== undefined
    && (database.name === ":memory:" || database.name === "");
  const register = database.transaction(() => {
    for (const config of configs) {
      database.prepare(
        `INSERT INTO retailers
           (id, name, base_url, cep, platform_hint, domains_json, active,
            degraded, degraded_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           cep = excluded.cep,
           platform_hint = excluded.platform_hint,
           domains_json = excluded.domains_json,
           active = excluded.active,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run(
        config.id,
        config.name,
        config.baseUrl,
        config.cep,
        config.platformEvidence.platform,
        JSON.stringify(config.allowedDomains),
        config.active && activate ? 1 : 0,
      );

      for (const [purpose, strategy] of [
        ["discovery", config.discovery],
        ["extraction", config.extraction],
      ] as const) {
        const version = config.strategyVersions[purpose];
        const id = `${config.id}-${purpose}-v${version}`;
        const strategyActive = config.active && activate ? 1 : 0;
        const validation = config.validation[purpose];
        const activationEvidence = strategyActive === 1 && verificationPublicKey !== null
          ? validatedActivationEvidence(
            database,
            config,
            purpose,
            options,
            verificationPublicKey,
            allowEmptyTestCatalog,
          )
          : null;
        const bootstrap = !activate && config.active;
        const sampleSize = bootstrap ? 0 : activationEvidence?.attempted ?? validation.sampleSize;
        const successes = bootstrap ? 0 : activationEvidence?.valid ?? validation.successes;
        const score = bootstrap ? 0 : activationEvidence?.score ?? validation.score;
        const validatedAt = bootstrap
          ? null
          : activationEvidence?.validatedAt ?? validation.validatedAt;
        const lifecycleAt = validation.validatedAt ?? config.platformEvidence.observedAt;
        const tier = strategyTier(strategy);
        const strategyJson = JSON.stringify(strategy);
        const provenance = `retailer config; ${validation.evidence}`;
        const existingImmutable = database.prepare(
          `SELECT retailer_id, purpose, tier, version, strategy_json, provenance,
                  retired_at
           FROM strategies WHERE id = ?`,
        ).get(id) as {
          retailer_id: string;
          purpose: string;
          tier: number;
          version: number;
          strategy_json: string;
          provenance: string;
          retired_at: string | null;
        } | undefined;
        if (existingImmutable !== undefined && (
          existingImmutable.retailer_id !== config.id
          || existingImmutable.purpose !== purpose
          || existingImmutable.tier !== tier
          || existingImmutable.version !== version
          || existingImmutable.strategy_json !== strategyJson
          || existingImmutable.provenance !== provenance
        )) {
          throw new Error(
            `Strategy ${id} changed immutable fields; create a version bump instead`,
          );
        }
        if (
          existingImmutable?.retired_at !== null
          && existingImmutable?.retired_at !== undefined
          && strategyActive === 1
        ) {
          throw new Error(
            `Strategy ${id} is retired; activation requires a successor version`,
          );
        }
        if (strategyActive === 1) {
          database.prepare(
            `UPDATE strategies
             SET active = 0, retired_at = COALESCE(retired_at, ?)
             WHERE retailer_id = ? AND purpose = ? AND active = 1 AND id <> ?`,
          ).run(lifecycleAt, config.id, purpose, id);
        } else {
          database.prepare(
            `UPDATE strategies
             SET active = 0, retired_at = COALESCE(retired_at, ?)
             WHERE retailer_id = ? AND purpose = ? AND active = 1`,
          ).run(lifecycleAt, config.id, purpose);
        }
        if (existingImmutable === undefined) {
          database.prepare(
            `INSERT INTO strategies
             (id, retailer_id, purpose, tier, version, strategy_json, provenance,
              validation_sample_size, validation_successes, validation_rate,
              active, validated_at, activated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            config.id,
            purpose,
            tier,
            version,
            strategyJson,
            provenance,
            sampleSize,
            successes,
            sampleSize === 0 ? null : score,
            0,
            validatedAt,
            null,
          );
        }

        database.prepare(
          `UPDATE strategies
           SET validation_sample_size = ?, validation_successes = ?,
               validation_rate = ?, validated_at = ?
           WHERE id = ?`,
        ).run(
          sampleSize,
          successes,
          sampleSize === 0 ? null : score,
          validatedAt,
          id,
        );

        if (strategyActive === 1 && activationEvidence !== null) {
          const receiptPath = validation.receiptPath;
          const receiptSha256 = validation.receiptSha256;
          if (receiptPath === null || receiptSha256 === null) {
            throw new Error(`Active strategy ${id} lacks bound receipt evidence`);
          }
          const immutableEvidence = {
            strategy_id: id,
            receipt_path: receiptPath,
            receipt_sha256: receiptSha256,
            sample_set_sha256: activationEvidence.sampleSetSha256,
            executor_json: JSON.stringify(activationEvidence.executor),
            attestation_key_id: activationEvidence.attestation.keyId,
            attempted: activationEvidence.attempted,
            valid: activationEvidence.valid,
            score: activationEvidence.score,
            validated_at: activationEvidence.validatedAt,
            recorded_at: new Date().toISOString(),
          };
          const existingEvidence = database.prepare(
            `SELECT strategy_id, receipt_path, receipt_sha256, sample_set_sha256,
                    executor_json, attestation_key_id, attempted, valid, score,
                    validated_at
             FROM strategy_validation_evidence WHERE strategy_id = ?`,
          ).get(id) as Omit<typeof immutableEvidence, "recorded_at"> | undefined;
          if (existingEvidence === undefined) {
            insertVerifiedStrategyValidationEvidence(database, {
              strategyId: id,
              receiptPath,
              receiptSha256,
              evidence: activationEvidence,
              recordedAt: immutableEvidence.recorded_at,
              ...(options.testVerificationPublicKey === undefined
                ? {}
                : { testVerificationPublicKey: options.testVerificationPublicKey }),
            });
          } else if (
            JSON.stringify(existingEvidence)
              !== JSON.stringify({
                strategy_id: immutableEvidence.strategy_id,
                receipt_path: immutableEvidence.receipt_path,
                receipt_sha256: immutableEvidence.receipt_sha256,
                sample_set_sha256: immutableEvidence.sample_set_sha256,
                executor_json: immutableEvidence.executor_json,
                attestation_key_id: immutableEvidence.attestation_key_id,
                attempted: immutableEvidence.attempted,
                valid: immutableEvidence.valid,
                score: immutableEvidence.score,
                validated_at: immutableEvidence.validated_at,
              })
          ) {
            throw new Error(
              `Strategy ${id} already binds different immutable validation evidence; `
              + "create a successor version",
            );
          }
        }

        database.prepare(
          `UPDATE strategies
             SET active = ?,
                 activated_at = CASE WHEN ? = 1 THEN COALESCE(activated_at, ?) ELSE activated_at END,
                 retired_at = retired_at
           WHERE id = ?`,
        ).run(
          strategyActive,
          strategyActive,
          validatedAt,
          id,
        );
      }
    }
  });
  register.immediate();
}
