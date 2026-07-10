import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type Database from "better-sqlite3";
import { z } from "zod";

import { executeExtraction } from "../collection/executor.js";
import {
  DiscoveryStrategySchema,
  ExtractionStrategySchema,
  type DiscoveryStrategy,
  type ExtractionStrategy,
} from "../strategies/schema.js";

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
    min: z.number().int().min(500).max(30_000),
    max: z.number().int().min(500).max(30_000),
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
  switch (strategy.tier) {
    case "api":
    case "sitemap":
      return 1;
    case "embedded-json":
    case "dom-crawl":
      return 2;
    case "dom":
      return 3;
    case "script":
      return 4;
  }
}

export function registerRetailerConfigs(
  database: Database.Database,
  configs: readonly RetailerConfig[],
): void {
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
        config.active ? 1 : 0,
      );

      for (const [purpose, strategy] of [
        ["discovery", config.discovery],
        ["extraction", config.extraction],
      ] as const) {
        const version = config.strategyVersions[purpose];
        const id = `${config.id}-${purpose}-v${version}`;
        const strategyActive = config.active ? 1 : 0;
        const validation = config.validation[purpose];
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
            validation.sampleSize,
            validation.successes,
            validation.sampleSize === 0 ? null : validation.score,
            strategyActive,
            validation.validatedAt,
            strategyActive === 1 ? validation.validatedAt : null,
          );
        }

        database.prepare(
          `UPDATE strategies
             SET active = ?, validation_sample_size = ?, validation_successes = ?,
                 validation_rate = ?, validated_at = ?,
                 activated_at = CASE WHEN ? = 1 THEN COALESCE(activated_at, ?) ELSE activated_at END,
                 retired_at = retired_at
           WHERE id = ?`,
        ).run(
          strategyActive,
          validation.sampleSize,
          validation.successes,
          validation.sampleSize === 0 ? null : validation.score,
          validation.validatedAt,
          strategyActive,
          validation.validatedAt,
          id,
        );
      }
    }
  });
  register.immediate();
}
