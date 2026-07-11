import {
  createHash,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { openDatabase } from "../db/database.js";
import {
  findRunHealthEvidence,
  listStrategyValidationRefs,
} from "../db/repositories.js";
import { CodexStrategyGenerator, resolveExplorerApiKey } from "../explorer/codex-provider.js";
import { classifyRunHealth } from "../healing/classify-failure.js";
import { healPendingEvents } from "../healing/heal.js";
import { monitorRun } from "../healing/monitor.js";
import { databaseSourceSnapshotSha256 } from "../index/export.js";
import { runCollection } from "../pipeline/collect.js";
import {
  loadRetailerConfigs,
  RetailerConfigSchema,
  type RetailerConfig,
} from "../retailers/config.js";
import {
  ApiExtractionStrategySchema,
  ExtractionStrategySchema,
  type ApiExtractionStrategy,
} from "../strategies/schema.js";
import {
  readStrategyValidationEvidence,
  readValidationVerificationPublicKey,
  validationReceiptSha256,
  type StrategyValidationEvidence,
} from "../strategies/validation-evidence.js";
import { withProcessLock } from "./lock.js";
import {
  canonicalReleaseJson,
  readReleaseSigningPrivateKey,
  readReleaseVerificationPublicKey,
  releaseSigningKeyId,
  validateFrozenRelease,
  type ReleaseManifest,
} from "./release-manifest.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u).refine(
  (value) => value !== "0".repeat(64),
  "Placeholder SHA-256 values are forbidden",
);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
const DrillIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const ReleaseIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const RelativeDatabasePathSchema = z.string().regex(
  /^var\/acceptance\/m5-healing\/[a-f0-9]{32}\/staging\.sqlite$/u,
);
const RelativeReceiptPathSchema = z.string().regex(
  /^data\/validation\/[a-z0-9-]+-extraction-v\d+\.json$/u,
);
const ScoreSchema = z.number().finite().min(0).max(1);
const SAFETY_TRIGGER_NAMES = [
  "strategies_activation_requires_validation_evidence",
  "strategies_active_validation_binding_no_update",
] as const;
const SABOTAGED_API_FIELDS = {
  title: "$.m5DeliberatelyBrokenSelector.title",
  brand: "$.m5DeliberatelyBrokenSelector.brand",
  price: "$.m5DeliberatelyBrokenSelector.price",
  promoPrice: "$.m5DeliberatelyBrokenSelector.promoPrice",
  unit: "$.m5DeliberatelyBrokenSelector.unit",
  availability: "$.m5DeliberatelyBrokenSelector.availability",
} as const;

const RunEvidenceSchema = z.object({
  id: IdSchema,
  strategyId: IdSchema,
  strategyVersion: z.number().int().positive(),
  attempted: z.number().int().positive(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  successRate: ScoreSchema,
  status: z.enum(["completed", "partial", "failed"]),
}).strict();

export const HealingSabotageDrillPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  drill: z.literal("installed-release-healing-sabotage"),
  status: z.literal("pass"),
  drillId: DrillIdSchema,
  observedAt: z.string().datetime({ offset: true }),
  release: z.object({
    releaseId: ReleaseIdSchema,
    sourceCommit: CommitSchema,
    manifestSha256: Sha256Schema,
    artifactSetSha256: Sha256Schema,
    implementationSha256: Sha256Schema,
  }).strict(),
  staging: z.object({
    databaseRelativePath: RelativeDatabasePathSchema,
    databaseSha256: Sha256Schema,
    schemaVersion: z.number().int().positive(),
    integrityCheck: z.literal("ok"),
    foreignKeyViolations: z.literal(0),
    sourceSnapshotSha256Before: Sha256Schema,
    sourceSnapshotSha256After: Sha256Schema,
    sourceUnchanged: z.literal(true),
    templateRetailerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    disposableRetailerId: z.string().regex(/^m5-drill-[a-f0-9]{12}$/u),
    configSha256: Sha256Schema,
    sabotageKind: z.literal("staging-only-invalid-json-field-selectors"),
    brokenStrategySha256: Sha256Schema,
    restoredSafetyTriggerSetSha256: Sha256Schema,
  }).strict(),
  brokenRun: RunEvidenceSchema,
  monitor: z.object({
    health: z.literal("drift"),
    action: z.literal("queued"),
    healingEventId: IdSchema,
  }).strict(),
  healing: z.object({
    status: z.literal("recovered"),
    attempts: z.number().int().positive(),
    activated: z.literal(true),
    explorationRunId: IdSchema,
    successorStrategyId: IdSchema,
    successorStrategyVersion: z.number().int().min(2),
  }).strict(),
  cost: z.object({
    provider: z.literal("codex-sdk"),
    model: z.string().trim().min(1).max(200),
    reservationStatus: z.literal("settled"),
    reservationAmountUsd: z.number().finite().positive().max(5),
    actualCostUsd: z.number().finite().positive().max(5),
    ledgerRows: z.number().int().positive(),
    inputTokens: z.number().int().positive(),
    outputTokens: z.number().int().positive(),
  }).strict(),
  validation: z.object({
    receiptPath: RelativeReceiptPathSchema,
    receiptSha256: Sha256Schema,
    sampleSetSha256: Sha256Schema,
    attempted: z.literal(30),
    valid: z.number().int().min(27).max(30),
    score: ScoreSchema,
    executorMode: z.literal("trusted-live-host"),
    validatorArtifactSha256: Sha256Schema,
    challengeAlgorithm: z.literal("active-in-scope-category-url-bucket-round-robin-v1"),
  }).strict(),
  recoveredRun: RunEvidenceSchema,
}).strict().superRefine((payload, context) => {
  if (payload.staging.sourceSnapshotSha256Before !== payload.staging.sourceSnapshotSha256After) {
    context.addIssue({ code: "custom", path: ["staging", "sourceUnchanged"], message: "Source database changed during the drill" });
  }
  if (payload.brokenRun.attempted !== payload.brokenRun.ok + payload.brokenRun.failed
    || payload.brokenRun.successRate !== payload.brokenRun.ok / payload.brokenRun.attempted
    || payload.brokenRun.successRate >= 0.7
    || payload.brokenRun.failed === 0) {
    context.addIssue({ code: "custom", path: ["brokenRun"], message: "Broken run does not prove drift" });
  }
  if (payload.validation.score !== payload.validation.valid / payload.validation.attempted) {
    context.addIssue({ code: "custom", path: ["validation", "score"], message: "Validation score is inconsistent" });
  }
  if (payload.recoveredRun.attempted !== payload.recoveredRun.ok + payload.recoveredRun.failed
    || payload.recoveredRun.successRate !== payload.recoveredRun.ok / payload.recoveredRun.attempted
    || payload.recoveredRun.successRate < 0.9
    || payload.recoveredRun.strategyId !== payload.healing.successorStrategyId
    || payload.recoveredRun.strategyVersion !== payload.healing.successorStrategyVersion) {
    context.addIssue({ code: "custom", path: ["recoveredRun"], message: "Recovered run does not prove the activated successor" });
  }
  if (payload.cost.actualCostUsd > payload.cost.reservationAmountUsd) {
    context.addIssue({ code: "custom", path: ["cost", "actualCostUsd"], message: "Actual cost exceeds its reservation" });
  }
});

const HealingSabotageDrillSignatureSchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: Sha256Schema,
  payloadSha256: Sha256Schema,
  value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict();

export const HealingSabotageDrillReceiptSchema = z.object({
  payload: HealingSabotageDrillPayloadSchema,
  signature: HealingSabotageDrillSignatureSchema,
}).strict();

export type HealingSabotageDrillPayload = z.infer<typeof HealingSabotageDrillPayloadSchema>;
export type HealingSabotageDrillReceipt = z.infer<typeof HealingSabotageDrillReceiptSchema>;
export const MAX_HEALING_DRILL_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export function assertHealingSabotageReceiptFresh(
  receipt: HealingSabotageDrillReceipt,
  now: Date,
): void {
  const observedAt = Date.parse(receipt.payload.observedAt);
  if (!Number.isFinite(now.getTime()) || observedAt > now.getTime()
    || now.getTime() - observedAt > MAX_HEALING_DRILL_AGE_MS) {
    throw new Error("Healing sabotage drill receipt is stale or future-dated");
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function appliedSchemaVersion(database: Database.Database): number {
  const row = database.prepare(
    "SELECT MAX(version) AS version FROM schema_migrations",
  ).get() as { version: number | null } | undefined;
  const version = row?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
    throw new Error("Healing staging database has no applied migration version");
  }
  return version;
}

export function signHealingSabotageDrillReceipt(
  input: HealingSabotageDrillPayload,
  privateKey: KeyObject,
): HealingSabotageDrillReceipt {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Healing drill signing key must be an Ed25519 private key");
  }
  const payload = HealingSabotageDrillPayloadSchema.parse(input);
  const canonical = canonicalReleaseJson(payload);
  return HealingSabotageDrillReceiptSchema.parse({
    payload,
    signature: {
      algorithm: "ed25519",
      keyId: releaseSigningKeyId(privateKey),
      payloadSha256: sha256(canonical),
      value: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  });
}

export function validateHealingSabotageDrillReceipt(
  input: unknown,
  publicKey: KeyObject,
): HealingSabotageDrillReceipt {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Healing drill verification key must be an Ed25519 public key");
  }
  const receipt = HealingSabotageDrillReceiptSchema.parse(input);
  const canonical = canonicalReleaseJson(receipt.payload);
  if (receipt.signature.keyId !== releaseSigningKeyId(publicKey)
    || receipt.signature.payloadSha256 !== sha256(canonical)
    || !verify(
      null,
      Buffer.from(canonical),
      publicKey,
      Buffer.from(receipt.signature.value, "base64"),
    )) {
    throw new Error("Healing sabotage drill signature is invalid");
  }
  return receipt;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function writeAtomic(path: string, value: unknown, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: mode === 0o600 ? 0o700 : 0o755 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function runEvidenceFromDatabase(
  database: Database.Database,
  runId: string,
): z.infer<typeof RunEvidenceSchema> {
  const row = database.prepare(`
    SELECT id, strategy_id AS strategyId, strategy_version AS strategyVersion,
           attempted, ok, failed, status
    FROM runs WHERE id = ?
  `).get(runId) as {
    id: string;
    strategyId: string | null;
    strategyVersion: number | null;
    attempted: number;
    ok: number;
    failed: number;
    status: string;
  } | undefined;
  if (row === undefined || row.strategyId === null || row.strategyVersion === null
    || row.attempted === 0) {
    throw new Error(`Healing drill run ${runId} is absent or unbound`);
  }
  return RunEvidenceSchema.parse({
    ...row,
    successRate: row.ok / row.attempted,
  });
}

interface ReleaseBinding {
  manifest: ReleaseManifest;
  manifestSha256: string;
  implementationSha256: string;
}

function releaseBinding(input: {
  releasePath: string;
  publicKeyPath: string;
  projectRoot: string;
}): ReleaseBinding {
  const manifest = validateFrozenRelease({
    releasePath: input.releasePath,
    publicKeyPath: input.publicKeyPath,
    expectedSourceRoot: input.projectRoot,
  });
  const manifestPath = join(input.releasePath, "release-manifest.json");
  const implementationPath = fileURLToPath(import.meta.url);
  const expectedImplementation = manifest.artifacts.find(
    ({ path }) => path === "dist/ops/healing-drill.js",
  );
  const implementationSha256 = fileSha256(implementationPath);
  if (expectedImplementation === undefined
    || resolve(implementationPath) !== join(input.releasePath, "dist/ops/healing-drill.js")
    || expectedImplementation.sha256 !== implementationSha256) {
    throw new Error("Healing drill must execute from the installed signed frozen release");
  }
  return {
    manifest,
    manifestSha256: fileSha256(manifestPath),
    implementationSha256,
  };
}

function assertInstalledRelease(
  projectRoot: string,
  releasePath: string,
  binding: ReleaseBinding,
): void {
  const receiptPath = join(projectRoot, "var/operations/systemd-install.json");
  const stat = lstatSync(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Installed-release receipt is absent or unsafe");
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  if (receipt.schemaVersion !== 2
    || receipt.releasePath !== releasePath
    || receipt.releaseId !== binding.manifest.releaseId
    || receipt.sourceCommit !== binding.manifest.sourceCommit
    || receipt.releaseManifestSha256 !== binding.manifestSha256) {
    throw new Error("Healing drill release is not the currently installed signed release");
  }
}

function captureAndDropTriggers(
  database: Database.Database,
  names: readonly string[],
): Array<{ name: string; sql: string }> {
  const triggers = names.map((name) => {
    const row = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(name) as { sql: string | null } | undefined;
    if (row?.sql === null || row?.sql === undefined) {
      throw new Error(`Required staging safety trigger is absent: ${name}`);
    }
    return { name, sql: row.sql };
  });
  for (const { name } of triggers) {
    database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
  return triggers;
}

function restoreTriggers(
  database: Database.Database,
  triggers: ReadonlyArray<{ name: string; sql: string }>,
): string {
  for (const trigger of triggers) database.exec(trigger.sql);
  for (const { name, sql } of triggers) {
    const row = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(name) as { sql: string | null } | undefined;
    if (row?.sql !== sql) throw new Error(`Staging safety trigger was not restored: ${name}`);
  }
  return healingSafetyTriggerSetSha256(database);
}

export function healingSafetyTriggerSetSha256(database: Database.Database): string {
  const triggers = SAFETY_TRIGGER_NAMES.map((name) => {
    const row = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(name) as { sql: string | null } | undefined;
    if (row?.sql === null || row?.sql === undefined) {
      throw new Error(`Required staging safety trigger is absent: ${name}`);
    }
    return `${name}\0${sha256(row.sql)}\n`;
  });
  return sha256(triggers.sort().join(""));
}

function brokenApiStrategy(strategy: ApiExtractionStrategy): ApiExtractionStrategy {
  return ApiExtractionStrategySchema.parse({
    ...strategy,
    fields: SABOTAGED_API_FIELDS,
  });
}

function disposableConfig(
  template: RetailerConfig,
  retailerId: string,
  strategy: ApiExtractionStrategy,
): RetailerConfig {
  const strategyVersions = { ...template.strategyVersions, extraction: 1 };
  return RetailerConfigSchema.parse({
    ...template,
    id: retailerId,
    name: `M5 staging drill from ${template.name}`,
    strategyVersions,
    extraction: strategy,
    validation: {
      discovery: {
        ...template.validation.discovery,
        receiptPath: `data/validation/${retailerId}-discovery-v${strategyVersions.discovery}.json`,
      },
      extraction: {
        ...template.validation.extraction,
        receiptPath: `data/validation/${retailerId}-extraction-v1.json`,
      },
    },
  });
}

function prepareRuntimeRoot(input: {
  stageRoot: string;
  releasePath: string;
  projectRoot: string;
  config: RetailerConfig;
  privateKeyPath: string;
}): string {
  const runtime = join(input.stageRoot, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  symlinkSync(join(input.releasePath, "dist"), join(runtime, "dist"), "dir");
  mkdirSync(join(runtime, "retailers"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(runtime, "retailers", `${input.config.id}.json`),
    `${JSON.stringify(input.config, null, 2)}\n`,
    { mode: 0o600 },
  );
  mkdirSync(join(runtime, "ops"), { recursive: true, mode: 0o700 });
  copyFileSync(
    join(input.projectRoot, "ops/validation-attestation-public.pem"),
    join(runtime, "ops/validation-attestation-public.pem"),
  );
  chmodSync(join(runtime, "ops/validation-attestation-public.pem"), 0o444);
  mkdirSync(join(runtime, "var/operations"), { recursive: true, mode: 0o700 });
  copyFileSync(input.privateKeyPath, join(runtime, "var/operations/validation-attestation-private.pem"));
  chmodSync(join(runtime, "var/operations/validation-attestation-private.pem"), 0o600);
  mkdirSync(join(runtime, "data/validation"), { recursive: true, mode: 0o700 });
  mkdirSync(join(runtime, "data/raw-html"), { recursive: true, mode: 0o700 });
  mkdirSync(join(runtime, "var/log/runs"), { recursive: true, mode: 0o700 });
  return runtime;
}

function removeRuntimeSecrets(runtimeRoot: string): void {
  rmSync(join(runtimeRoot, "var/operations"), { recursive: true, force: true });
}

interface LiveWorkflowResult {
  staging: Omit<HealingSabotageDrillPayload["staging"],
    "databaseSha256" | "schemaVersion" | "integrityCheck" | "foreignKeyViolations"
    | "sourceSnapshotSha256Before" | "sourceSnapshotSha256After" | "sourceUnchanged">;
  brokenRun: HealingSabotageDrillPayload["brokenRun"];
  monitor: HealingSabotageDrillPayload["monitor"];
  healing: HealingSabotageDrillPayload["healing"];
  cost: HealingSabotageDrillPayload["cost"];
  validation: HealingSabotageDrillPayload["validation"];
  recoveredRun: HealingSabotageDrillPayload["recoveredRun"];
}

async function executeLiveWorkflow(input: {
  projectRoot: string;
  databasePath: string;
  releasePath: string;
  privateKeyPath: string;
  drillId: string;
  authorizedSpendUsd: number;
  env: NodeJS.ProcessEnv;
  stageRoot: string;
}): Promise<LiveWorkflowResult & {
  sourceSnapshotSha256Before: string;
  sourceSnapshotSha256After: string;
}> {
  const source = new Database(input.databasePath, { readonly: true, fileMustExist: true });
  const stagingDatabasePath = join(input.stageRoot, "staging.sqlite");
  const sourceSnapshotSha256Before = databaseSourceSnapshotSha256(source);
  await source.backup(stagingDatabasePath);
  chmodSync(stagingDatabasePath, 0o600);
  const sourceSnapshotSha256AfterBackup = databaseSourceSnapshotSha256(source);
  if (sourceSnapshotSha256Before !== sourceSnapshotSha256AfterBackup) {
    source.close();
    throw new Error("Source database changed while the staging backup was created");
  }
  const database = openDatabase(stagingDatabasePath);
  let runtimeRoot: string | null = null;
  try {
    const configs = loadRetailerConfigs(join(input.releasePath, "retailers"));
    const candidates = database.prepare(`
      SELECT strategy.retailer_id AS retailerId, strategy.strategy_json AS strategyJson
      FROM strategies AS strategy
      JOIN retailers AS retailer ON retailer.id = strategy.retailer_id
      WHERE retailer.active = 1 AND strategy.active = 1
        AND strategy.purpose = 'extraction' AND strategy.tier = 1
        AND (SELECT COUNT(*) FROM products AS product
             WHERE product.retailer_id = strategy.retailer_id
               AND product.active = 1 AND product.in_scope = 1
               AND product.retailer_product_id IS NOT NULL) >= 30
      ORDER BY strategy.retailer_id
    `).all() as Array<{ retailerId: string; strategyJson: string }>;
    const selected = candidates.map((candidate) => ({
      candidate,
      config: configs.find(({ id }) => id === candidate.retailerId),
      strategy: ApiExtractionStrategySchema.safeParse(JSON.parse(candidate.strategyJson)),
    })).find(({ config, strategy }) => config !== undefined && strategy.success);
    if (selected?.config === undefined || !selected.strategy.success) {
      throw new Error("No active API extraction retailer has 30 staging references");
    }
    const disposableRetailerId = `m5-drill-${input.drillId.slice(0, 12)}`;
    const broken = brokenApiStrategy(selected.strategy.data);
    const config = disposableConfig(selected.config, disposableRetailerId, broken);
    const refs = listStrategyValidationRefs(database, selected.candidate.retailerId, 30);
    if (refs.length !== 30 || refs.some(({ externalId }) => externalId === null)) {
      throw new Error("Selected staging retailer lacks 30 exact external product IDs");
    }
    database.transaction(() => {
      const templateRetailer = database.prepare(`
        SELECT name, base_url, cep, platform_hint, domains_json
        FROM retailers WHERE id = ?
      `).get(selected.candidate.retailerId) as {
        name: string;
        base_url: string;
        cep: string;
        platform_hint: string | null;
        domains_json: string;
      } | undefined;
      if (templateRetailer === undefined) throw new Error("Template retailer disappeared");
      database.prepare(`
        INSERT INTO retailers
          (id, name, base_url, cep, platform_hint, domains_json, active, degraded)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0)
      `).run(
        disposableRetailerId,
        `M5 staging drill from ${templateRetailer.name}`,
        templateRetailer.base_url,
        templateRetailer.cep,
        templateRetailer.platform_hint,
        templateRetailer.domains_json,
      );
      const product = database.prepare(`
        SELECT title, brand, source_category, raw_unit, quantity_value,
               quantity_unit, base_quantity, base_unit, first_seen, last_seen
        FROM products WHERE retailer_id = ? AND canonical_url = ?
      `);
      const insert = database.prepare(`
        INSERT INTO products
          (id, retailer_id, canonical_url, retailer_product_id, title, brand,
           source_category, raw_unit, quantity_value, quantity_unit,
           base_quantity, base_unit, in_scope, active, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
      `);
      refs.forEach((ref, index) => {
        const row = product.get(selected.candidate.retailerId, ref.canonicalUrl) as {
          title: string;
          brand: string | null;
          source_category: string | null;
          raw_unit: string | null;
          quantity_value: number | null;
          quantity_unit: string | null;
          base_quantity: number | null;
          base_unit: string | null;
          first_seen: string;
          last_seen: string;
        } | undefined;
        if (row === undefined) throw new Error("Template product disappeared");
        insert.run(
          `${disposableRetailerId}-product-${index + 1}`,
          disposableRetailerId,
          ref.canonicalUrl,
          ref.externalId,
          row.title,
          row.brand,
          row.source_category,
          row.raw_unit,
          row.quantity_value,
          row.quantity_unit,
          row.base_quantity,
          row.base_unit,
          row.first_seen,
          row.last_seen,
        );
      });
      database.prepare(`
        INSERT INTO strategies
          (id, retailer_id, purpose, tier, version, strategy_json, provenance,
           validation_sample_size, validation_successes, validation_rate, active)
        VALUES (?, ?, 'extraction', 1, 1, ?,
                'M5 deliberate staging-only selector sabotage', 0, 0, NULL, 0)
      `).run(`${disposableRetailerId}-extraction-v1`, disposableRetailerId, JSON.stringify(broken));
    }).immediate();
    const triggers = captureAndDropTriggers(database, SAFETY_TRIGGER_NAMES);
    let restoredSafetyTriggerSetSha256: string;
    try {
      database.prepare(`
        UPDATE strategies SET active = 1, activated_at = ?
        WHERE id = ? AND active = 0
      `).run(new Date().toISOString(), `${disposableRetailerId}-extraction-v1`);
    } finally {
      restoredSafetyTriggerSetSha256 = restoreTriggers(database, triggers);
    }
    if ((database.prepare(
      "SELECT active FROM strategies WHERE id = ?",
    ).get(`${disposableRetailerId}-extraction-v1`) as { active: number }).active !== 1) {
      throw new Error("Staging sabotage strategy was not activated");
    }
    runtimeRoot = prepareRuntimeRoot({
      stageRoot: input.stageRoot,
      releasePath: input.releasePath,
      projectRoot: input.projectRoot,
      config,
      privateKeyPath: input.privateKeyPath,
    });
    const previousCwd = process.cwd();
    process.chdir(runtimeRoot);
    try {
      const commonCollection = {
        database,
        limit: 30,
        concurrency: 3,
        rawHtmlRoot: join(runtimeRoot, "data/raw-html"),
        logDirectory: join(runtimeRoot, "var/log/runs"),
        politeDelayMs: config.politeDelayMs,
      } as const;
      const brokenRunSummary = await runCollection(disposableRetailerId, commonCollection);
      const brokenRun = runEvidenceFromDatabase(database, brokenRunSummary.id);
      if (brokenRun.successRate >= 0.7 || brokenRun.failed === 0) {
        throw new Error("Deliberate staging selector sabotage did not produce drift");
      }
      const decision = await monitorRun(brokenRun.id, { database });
      if (decision.health !== "drift" || decision.action !== "queued"
        || decision.healingEventId === undefined) {
        throw new Error("Staging sabotage did not queue a drift healing event");
      }
      const apiKey = resolveExplorerApiKey(input.env);
      if (apiKey === undefined) throw new Error("Explorer credential disappeared before healing");
      const generator = new CodexStrategyGenerator({ apiKey, env: input.env });
      const worker = await healPendingEvents({
        database,
        retailerId: disposableRetailerId,
        generator,
        env: input.env,
        eventBudgetUsd: input.authorizedSpendUsd,
        monthlyBudgetUsd: 50,
        replayRoot: join(runtimeRoot, "data/raw-html"),
      });
      if (worker.recovered !== 1 || worker.processed !== 1) {
        throw new Error("Credential-backed staging healing did not recover exactly one event");
      }
      const event = database.prepare(`
        SELECT status, attempts, successor_strategy_id AS successorStrategyId
        FROM healing_events WHERE id = ?
      `).get(decision.healingEventId) as {
        status: string;
        attempts: number;
        successorStrategyId: string | null;
      } | undefined;
      if (event?.status !== "recovered" || event.successorStrategyId === null) {
        throw new Error("Recovered healing event lacks an activated successor");
      }
      const exploration = database.prepare(`
        SELECT id, status, outcome, trigger, candidate_strategy_id AS candidateStrategyId,
               input_tokens AS inputTokens, output_tokens AS outputTokens,
               cost_usd AS costUsd
        FROM exploration_runs WHERE healing_event_id = ?
      `).get(decision.healingEventId) as {
        id: string;
        status: string;
        outcome: string | null;
        trigger: string;
        candidateStrategyId: string | null;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
      } | undefined;
      if (exploration === undefined || exploration.status !== "finished"
        || exploration.outcome !== "activated" || exploration.trigger !== "healing"
        || exploration.candidateStrategyId !== event.successorStrategyId
        || exploration.inputTokens <= 0 || exploration.outputTokens <= 0
        || exploration.costUsd <= 0) {
        throw new Error("Healing exploration lacks genuine model usage and activation evidence");
      }
      const cost = database.prepare(`
        SELECT reservation.status AS reservationStatus,
               reservation.amount_usd AS reservationAmountUsd,
               reservation.actual_cost_usd AS actualCostUsd,
               COUNT(ledger.id) AS ledgerRows,
               COALESCE(SUM(ledger.input_tokens), 0) AS inputTokens,
               COALESCE(SUM(ledger.output_tokens), 0) AS outputTokens,
               COALESCE(SUM(ledger.cost_usd), 0) AS ledgerCostUsd,
               MIN(ledger.provider) AS provider,
               MIN(ledger.model) AS model,
               COUNT(DISTINCT ledger.provider) AS providers,
               COUNT(DISTINCT ledger.model) AS models
        FROM model_budget_reservations AS reservation
        LEFT JOIN cost_ledger AS ledger
          ON ledger.exploration_run_id = reservation.exploration_run_id
         AND ledger.category = 'strategy-exploration'
        WHERE reservation.exploration_run_id = ?
        GROUP BY reservation.id
      `).get(exploration.id) as {
        reservationStatus: string;
        reservationAmountUsd: number;
        actualCostUsd: number | null;
        ledgerRows: number;
        inputTokens: number;
        outputTokens: number;
        ledgerCostUsd: number;
        provider: string | null;
        model: string | null;
        providers: number;
        models: number;
      } | undefined;
      if (cost === undefined || cost.reservationStatus !== "settled"
        || cost.actualCostUsd !== exploration.costUsd
        || cost.reservationAmountUsd !== input.authorizedSpendUsd
        || cost.ledgerRows < 1 || cost.inputTokens !== exploration.inputTokens
        || cost.outputTokens !== exploration.outputTokens
        || cost.ledgerCostUsd !== exploration.costUsd
        || cost.provider !== "codex-sdk" || cost.model === null
        || cost.providers !== 1 || cost.models !== 1) {
        throw new Error("Healing exploration cost reservation and ledger are inconsistent");
      }
      const successor = database.prepare(`
        SELECT id, version, strategy_json AS strategyJson
        FROM strategies WHERE id = ? AND retailer_id = ? AND purpose = 'extraction'
          AND active = 1
      `).get(event.successorStrategyId, disposableRetailerId) as {
        id: string;
        version: number;
        strategyJson: string;
      } | undefined;
      if (successor === undefined || successor.version < 2) {
        throw new Error("Activated healing successor is absent");
      }
      const validationRow = database.prepare(`
        SELECT receipt_path AS receiptPath, receipt_sha256 AS receiptSha256,
               sample_set_sha256 AS sampleSetSha256, executor_json AS executorJson,
               attempted, valid, score
        FROM strategy_validation_evidence WHERE strategy_id = ?
      `).get(successor.id) as {
        receiptPath: string;
        receiptSha256: string;
        sampleSetSha256: string;
        executorJson: string;
        attempted: number;
        valid: number;
        score: number;
      } | undefined;
      if (validationRow === undefined) throw new Error("Successor validation evidence is absent");
      const executor = JSON.parse(validationRow.executorJson) as Record<string, unknown>;
      const expectedReceiptPath = `data/validation/${disposableRetailerId}-extraction-v${successor.version}.json`;
      if (validationRow.receiptPath !== expectedReceiptPath
        || validationRow.attempted !== 30 || validationRow.valid < 27
        || validationRow.score !== validationRow.valid / 30
        || executor.mode !== "trusted-live-host"
        || typeof executor.artifactSha256 !== "string"
        || executor.challengeAlgorithm !== "active-in-scope-category-url-bucket-round-robin-v1") {
        throw new Error("Successor lacks exact trusted 30-reference validation evidence");
      }
      const receipt = readStrategyValidationEvidence(join(runtimeRoot, expectedReceiptPath), {
        retailerId: disposableRetailerId,
        purpose: "extraction",
        strategyVersion: successor.version,
        strategy: ExtractionStrategySchema.parse(JSON.parse(successor.strategyJson)),
        verificationPublicKey: readValidationVerificationPublicKey(
          join(input.projectRoot, "ops/validation-attestation-public.pem"),
        ),
        authoritativeRefs: listStrategyValidationRefs(database, disposableRetailerId, 30),
      });
      if (validationReceiptSha256(receipt) !== validationRow.receiptSha256) {
        throw new Error("Successor receipt digest differs from its database binding");
      }
      const recoveredSummary = await runCollection(disposableRetailerId, commonCollection);
      const recoveredRun = runEvidenceFromDatabase(database, recoveredSummary.id);
      if (recoveredRun.strategyId !== successor.id || recoveredRun.strategyVersion !== successor.version
        || recoveredRun.successRate < 0.9) {
        throw new Error("Activated successor did not recover the staging collection");
      }
      database.pragma("wal_checkpoint(TRUNCATE)");
      return {
        staging: {
          databaseRelativePath: `var/acceptance/m5-healing/${input.drillId}/staging.sqlite`,
          templateRetailerId: selected.candidate.retailerId,
          disposableRetailerId,
          configSha256: sha256(`${JSON.stringify(config, null, 2)}\n`),
          sabotageKind: "staging-only-invalid-json-field-selectors",
          brokenStrategySha256: sha256(canonicalReleaseJson(broken)),
          restoredSafetyTriggerSetSha256,
        },
        brokenRun,
        monitor: {
          health: "drift",
          action: "queued",
          healingEventId: decision.healingEventId,
        },
        healing: {
          status: "recovered",
          attempts: event.attempts,
          activated: true,
          explorationRunId: exploration.id,
          successorStrategyId: successor.id,
          successorStrategyVersion: successor.version,
        },
        cost: {
          provider: "codex-sdk",
          model: cost.model,
          reservationStatus: "settled",
          reservationAmountUsd: cost.reservationAmountUsd,
          actualCostUsd: cost.actualCostUsd,
          ledgerRows: cost.ledgerRows,
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
        },
        validation: {
          receiptPath: validationRow.receiptPath,
          receiptSha256: validationRow.receiptSha256,
          sampleSetSha256: validationRow.sampleSetSha256,
          attempted: 30,
          valid: validationRow.valid,
          score: validationRow.score,
          executorMode: "trusted-live-host",
          validatorArtifactSha256: String(executor.artifactSha256),
          challengeAlgorithm: "active-in-scope-category-url-bucket-round-robin-v1",
        },
        recoveredRun,
        sourceSnapshotSha256Before,
        sourceSnapshotSha256After: databaseSourceSnapshotSha256(source),
      };
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    if (runtimeRoot !== null) removeRuntimeSecrets(runtimeRoot);
    database.close();
    source.close();
  }
}

export interface HealingSabotageDrillOptions {
  projectRoot: string;
  databasePath: string;
  releasePath: string;
  publicKeyPath: string;
  privateKeyPath: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  drillId?: () => string;
  confirmStagingSabotage: boolean;
  authorizedSpendUsd: number;
  publicReceiptPath?: string;
  privateReceiptPath?: string;
}

export async function runHealingSabotageDrill(
  options: HealingSabotageDrillOptions,
): Promise<HealingSabotageDrillReceipt> {
  const projectRoot = resolve(options.projectRoot);
  const databasePath = resolve(options.databasePath);
  const releasePath = resolve(options.releasePath);
  const publicKeyPath = resolve(options.publicKeyPath);
  const privateKeyPath = resolve(options.privateKeyPath);
  const environment = options.env ?? process.env;
  if (!options.confirmStagingSabotage) {
    throw new Error("--confirm-staging-sabotage is required");
  }
  if (environment.LIVE_OPENAI !== "1") {
    throw new Error("LIVE_OPENAI=1 is required for the paid healing drill");
  }
  if (resolveExplorerApiKey(environment) === undefined) {
    throw new Error("A real explorer credential is required for the healing drill");
  }
  if (!Number.isFinite(options.authorizedSpendUsd)
    || options.authorizedSpendUsd <= 0 || options.authorizedSpendUsd > 5) {
    throw new Error("--authorize-live-spend-usd must be positive and at most 5");
  }
  if (!inside(projectRoot, databasePath) || databasePath === resolve(projectRoot, "var")) {
    throw new Error("Healing drill source database must remain inside the project root");
  }
  const binding = releaseBinding({ releasePath, publicKeyPath, projectRoot });
  assertInstalledRelease(projectRoot, releasePath, binding);
  const signingKey = readReleaseSigningPrivateKey(privateKeyPath);
  const verificationKey = readReleaseVerificationPublicKey(publicKeyPath);
  if (releaseSigningKeyId(signingKey) !== releaseSigningKeyId(verificationKey)) {
    throw new Error("Healing drill signing key does not match the installed release trust anchor");
  }
  const rawDrillId = (options.drillId ?? (() => randomBytes(16).toString("hex")))();
  const drillId = DrillIdSchema.parse(rawDrillId.replaceAll("-", "").toLowerCase());
  const stageRoot = resolve(projectRoot, `var/acceptance/m5-healing/${drillId}`);
  if (!inside(projectRoot, stageRoot) || existsSync(stageRoot)) {
    throw new Error("Healing drill staging directory already exists or escaped the project root");
  }
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  const pipelineLock = join(projectRoot, "var/precos-pipeline.lock");
  const explorerLock = join(projectRoot, "var/precos-explorer.lock");
  const result = await withProcessLock(pipelineLock, () =>
    withProcessLock(explorerLock, () => executeLiveWorkflow({
      projectRoot,
      databasePath,
      releasePath,
      privateKeyPath,
      drillId,
      authorizedSpendUsd: options.authorizedSpendUsd,
      env: environment,
      stageRoot,
    })));
  if (result.sourceSnapshotSha256Before !== result.sourceSnapshotSha256After) {
    throw new Error("Production source database changed during the isolated staging drill");
  }
  const stagingDatabasePath = join(stageRoot, "staging.sqlite");
  chmodSync(stagingDatabasePath, 0o600);
  const staging = new Database(stagingDatabasePath, { readonly: true, fileMustExist: true });
  const integrityCheck = String(staging.pragma("integrity_check", { simple: true }));
  const foreignKeyViolations = (staging.pragma("foreign_key_check") as unknown[]).length;
  const schemaVersion = appliedSchemaVersion(staging);
  staging.close();
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const payload = HealingSabotageDrillPayloadSchema.parse({
    schemaVersion: 1,
    drill: "installed-release-healing-sabotage",
    status: "pass",
    drillId,
    observedAt,
    release: {
      releaseId: binding.manifest.releaseId,
      sourceCommit: binding.manifest.sourceCommit,
      manifestSha256: binding.manifestSha256,
      artifactSetSha256: binding.manifest.artifactSetSha256,
      implementationSha256: binding.implementationSha256,
    },
    staging: {
      ...result.staging,
      databaseSha256: fileSha256(stagingDatabasePath),
      schemaVersion,
      integrityCheck,
      foreignKeyViolations,
      sourceSnapshotSha256Before: result.sourceSnapshotSha256Before,
      sourceSnapshotSha256After: result.sourceSnapshotSha256After,
      sourceUnchanged: true,
    },
    brokenRun: result.brokenRun,
    monitor: result.monitor,
    healing: result.healing,
    cost: result.cost,
    validation: result.validation,
    recoveredRun: result.recoveredRun,
  });
  const receipt = signHealingSabotageDrillReceipt(
    payload,
    signingKey,
  );
  const privateReceiptPath = resolve(
    options.privateReceiptPath ?? join(projectRoot, "var/acceptance/healing-sabotage-drill.json"),
  );
  const publicReceiptPath = resolve(
    options.publicReceiptPath
      ?? join(projectRoot, "data/acceptance/evidence/healing-sabotage-drill.json"),
  );
  if (!inside(projectRoot, privateReceiptPath) || !inside(projectRoot, publicReceiptPath)) {
    throw new Error("Healing drill receipt paths must remain inside the project root");
  }
  writeAtomic(privateReceiptPath, receipt, 0o600);
  writeAtomic(publicReceiptPath, receipt, 0o644);
  return receipt;
}

export interface ValidateHealingSabotageEvidenceOptions {
  projectRoot: string;
  releasePath: string;
  publicKeyPath: string;
  receiptPath: string;
  expectedSourceCommit: string;
  expectedReleaseId: string;
  now: Date;
}

export interface ValidateHealingSabotageRetainedBindingsOptions {
  database: Database.Database;
  receipt: HealingSabotageDrillReceipt;
  stagingDatabasePath: string;
  successorEvidence: StrategyValidationEvidence;
}

/**
 * Recomputes the private, post-hoc facts that the public receipt summarizes.
 * Signature/release verification is deliberately performed by the outer
 * validator before this function is reached.
 */
export function validateHealingSabotageRetainedBindings(
  options: ValidateHealingSabotageRetainedBindingsOptions,
): void {
  const { database, receipt, successorEvidence } = options;
  const brokenRow = database.prepare(`
    SELECT retailer_id AS retailerId, purpose, tier, version,
           strategy_json AS strategyJson, active
    FROM strategies WHERE id = ?
  `).get(receipt.payload.brokenRun.strategyId) as {
    retailerId: string;
    purpose: string;
    tier: number;
    version: number;
    strategyJson: string;
    active: number;
  } | undefined;
  let brokenStrategy: ApiExtractionStrategy;
  try {
    if (brokenRow === undefined) throw new Error("missing");
    brokenStrategy = ApiExtractionStrategySchema.parse(JSON.parse(brokenRow.strategyJson));
  } catch (error) {
    throw new Error("Retained broken strategy is absent or malformed", { cause: error });
  }
  if (brokenRow.retailerId !== receipt.payload.staging.disposableRetailerId
    || brokenRow.purpose !== "extraction" || brokenRow.tier !== 1
    || brokenRow.version !== 1 || brokenRow.active !== 0
    || canonicalReleaseJson(brokenStrategy.fields)
      !== canonicalReleaseJson(SABOTAGED_API_FIELDS)
    || sha256(canonicalReleaseJson(brokenStrategy))
      !== receipt.payload.staging.brokenStrategySha256) {
    throw new Error("Retained broken strategy differs from the signed sabotage");
  }

  const healthEvidence = findRunHealthEvidence(database, receipt.payload.brokenRun.id);
  if (healthEvidence.run.retailerId !== receipt.payload.staging.disposableRetailerId
    || healthEvidence.run.strategyId !== receipt.payload.brokenRun.strategyId
    || classifyRunHealth(healthEvidence.run, healthEvidence.failures) !== "drift") {
    throw new Error("Persisted broken-run failures do not independently prove drift");
  }

  const event = database.prepare(`
    SELECT retailer_id AS retailerId, purpose, onset_run_id AS onsetRunId,
           previous_strategy_id AS previousStrategyId, category,
           successor_strategy_id AS successorStrategyId, status, attempts
    FROM healing_events WHERE id = ?
  `).get(receipt.payload.monitor.healingEventId) as {
    retailerId: string;
    purpose: string;
    onsetRunId: string | null;
    previousStrategyId: string | null;
    category: string;
    successorStrategyId: string | null;
    status: string;
    attempts: number;
  } | undefined;
  if (event === undefined
    || event.retailerId !== receipt.payload.staging.disposableRetailerId
    || event.purpose !== "extraction" || event.category !== "drift"
    || event.onsetRunId !== receipt.payload.brokenRun.id
    || event.previousStrategyId !== receipt.payload.brokenRun.strategyId
    || event.successorStrategyId !== receipt.payload.healing.successorStrategyId
    || event.status !== "recovered"
    || event.attempts !== receipt.payload.healing.attempts) {
    throw new Error("Retained healing event is not bound to the broken drift strategy");
  }

  const runtimeRoot = join(dirname(options.stagingDatabasePath), "runtime");
  const configPath = join(
    runtimeRoot,
    "retailers",
    `${receipt.payload.staging.disposableRetailerId}.json`,
  );
  const configStat = lstatSync(configPath);
  const configBytes = readFileSync(configPath);
  let config: RetailerConfig;
  try {
    config = RetailerConfigSchema.parse(JSON.parse(configBytes.toString("utf8")));
  } catch (error) {
    throw new Error("Retained healing drill config is malformed", { cause: error });
  }
  if (!configStat.isFile() || configStat.isSymbolicLink()
    || (configStat.mode & 0o777) !== 0o600
    || sha256(configBytes) !== receipt.payload.staging.configSha256
    || config.id !== receipt.payload.staging.disposableRetailerId
    || config.strategyVersions.extraction !== 1
    || canonicalReleaseJson(config.extraction) !== canonicalReleaseJson(brokenStrategy)) {
    throw new Error("Retained healing drill config differs from its signed binding");
  }
  if (existsSync(join(
    runtimeRoot,
    "var/operations/validation-attestation-private.pem",
  ))) {
    throw new Error("Copied healing drill signing key was not removed");
  }
  if (healingSafetyTriggerSetSha256(database)
    !== receipt.payload.staging.restoredSafetyTriggerSetSha256) {
    throw new Error("Restored staging safety triggers differ from their signed binding");
  }

  const validation = database.prepare(`
    SELECT receipt_path AS receiptPath, receipt_sha256 AS receiptSha256,
           sample_set_sha256 AS sampleSetSha256, executor_json AS executorJson,
           attestation_key_id AS attestationKeyId, attempted, valid, score,
           validated_at AS validatedAt
    FROM strategy_validation_evidence WHERE strategy_id = ?
  `).get(receipt.payload.healing.successorStrategyId) as {
    receiptPath: string;
    receiptSha256: string;
    sampleSetSha256: string;
    executorJson: string;
    attestationKeyId: string;
    attempted: number;
    valid: number;
    score: number;
    validatedAt: string;
  } | undefined;
  let storedExecutor: unknown;
  try {
    if (validation === undefined) throw new Error("missing");
    storedExecutor = JSON.parse(validation.executorJson);
  } catch (error) {
    throw new Error("Retained successor validation database binding is absent", { cause: error });
  }
  if (validation.receiptPath !== receipt.payload.validation.receiptPath
    || validation.receiptSha256 !== receipt.payload.validation.receiptSha256
    || validation.receiptSha256 !== validationReceiptSha256(successorEvidence)
    || validation.sampleSetSha256 !== receipt.payload.validation.sampleSetSha256
    || validation.sampleSetSha256 !== successorEvidence.sampleSetSha256
    || canonicalReleaseJson(storedExecutor) !== canonicalReleaseJson(successorEvidence.executor)
    || validation.attestationKeyId !== successorEvidence.attestation.keyId
    || validation.attempted !== receipt.payload.validation.attempted
    || validation.attempted !== successorEvidence.attempted
    || validation.valid !== receipt.payload.validation.valid
    || validation.valid !== successorEvidence.valid
    || validation.score !== receipt.payload.validation.score
    || validation.score !== successorEvidence.score
    || validation.validatedAt !== successorEvidence.validatedAt) {
    throw new Error("Retained successor validation database row differs from its receipt");
  }
}

export function validateHealingSabotageEvidence(
  options: ValidateHealingSabotageEvidenceOptions,
): HealingSabotageDrillReceipt {
  const root = resolve(options.projectRoot);
  const receiptPath = resolve(options.receiptPath);
  if (!inside(root, receiptPath)) throw new Error("Healing drill receipt escaped project root");
  const receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
    throw new Error("Healing drill receipt must be a regular file");
  }
  const publicKey = readReleaseVerificationPublicKey(options.publicKeyPath);
  const receipt = validateHealingSabotageDrillReceipt(
    JSON.parse(readFileSync(receiptPath, "utf8")),
    publicKey,
  );
  assertHealingSabotageReceiptFresh(receipt, options.now);
  const manifest = validateFrozenRelease({
    releasePath: options.releasePath,
    publicKeyPath: options.publicKeyPath,
    expectedSourceCommit: options.expectedSourceCommit,
    expectedReleaseId: options.expectedReleaseId,
    expectedSourceRoot: root,
  });
  if (receipt.payload.release.releaseId !== manifest.releaseId
    || receipt.payload.release.sourceCommit !== manifest.sourceCommit
    || receipt.payload.release.manifestSha256
      !== fileSha256(join(options.releasePath, "release-manifest.json"))
    || receipt.payload.release.artifactSetSha256 !== manifest.artifactSetSha256) {
    throw new Error("Healing drill receipt is bound to a different installed release");
  }
  const implementation = manifest.artifacts.find(
    ({ path }) => path === "dist/ops/healing-drill.js",
  );
  if (implementation?.sha256 !== receipt.payload.release.implementationSha256) {
    throw new Error("Healing drill implementation is not bound to the release manifest");
  }
  const stagingDatabasePath = resolve(root, receipt.payload.staging.databaseRelativePath);
  if (!inside(root, stagingDatabasePath)) throw new Error("Healing staging database escaped root");
  const stat = lstatSync(stagingDatabasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
    || fileSha256(stagingDatabasePath) !== receipt.payload.staging.databaseSha256) {
    throw new Error("Healing staging database is absent, unsafe, or differs from its receipt");
  }
  const database = new Database(stagingDatabasePath, { readonly: true, fileMustExist: true });
  try {
    if (String(database.pragma("integrity_check", { simple: true })) !== "ok"
      || (database.pragma("foreign_key_check") as unknown[]).length !== 0
      || appliedSchemaVersion(database) !== receipt.payload.staging.schemaVersion) {
      throw new Error("Healing staging database integrity or schema is invalid");
    }
    const broken = runEvidenceFromDatabase(database, receipt.payload.brokenRun.id);
    const recovered = runEvidenceFromDatabase(database, receipt.payload.recoveredRun.id);
    if (canonicalReleaseJson(broken) !== canonicalReleaseJson(receipt.payload.brokenRun)
      || canonicalReleaseJson(recovered) !== canonicalReleaseJson(receipt.payload.recoveredRun)) {
      throw new Error("Healing drill run rows differ from the signed receipt");
    }
    const event = database.prepare(`
      SELECT retailer_id AS retailerId, onset_run_id AS onsetRunId,
             successor_strategy_id AS successorStrategyId, status, attempts
      FROM healing_events WHERE id = ?
    `).get(receipt.payload.monitor.healingEventId) as {
      retailerId: string;
      onsetRunId: string | null;
      successorStrategyId: string | null;
      status: string;
      attempts: number;
    } | undefined;
    if (event === undefined
      || event.retailerId !== receipt.payload.staging.disposableRetailerId
      || event.onsetRunId !== broken.id || event.status !== "recovered"
      || event.successorStrategyId !== receipt.payload.healing.successorStrategyId
      || event.attempts !== receipt.payload.healing.attempts) {
      throw new Error("Healing event differs from the signed drill receipt");
    }
    const exploration = database.prepare(`
      SELECT status, outcome, trigger, candidate_strategy_id AS candidateStrategyId,
             input_tokens AS inputTokens, output_tokens AS outputTokens,
             cost_usd AS costUsd
      FROM exploration_runs WHERE id = ? AND healing_event_id = ?
    `).get(
      receipt.payload.healing.explorationRunId,
      receipt.payload.monitor.healingEventId,
    ) as {
      status: string;
      outcome: string | null;
      trigger: string;
      candidateStrategyId: string | null;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    } | undefined;
    if (exploration === undefined || exploration.status !== "finished"
      || exploration.outcome !== "activated" || exploration.trigger !== "healing"
      || exploration.candidateStrategyId !== receipt.payload.healing.successorStrategyId
      || exploration.inputTokens !== receipt.payload.cost.inputTokens
      || exploration.outputTokens !== receipt.payload.cost.outputTokens
      || exploration.costUsd !== receipt.payload.cost.actualCostUsd) {
      throw new Error("Healing exploration differs from its signed receipt");
    }
    const cost = database.prepare(`
      SELECT reservation.status AS reservationStatus,
             reservation.amount_usd AS reservationAmountUsd,
             reservation.actual_cost_usd AS actualCostUsd,
             COUNT(ledger.id) AS ledgerRows,
             COALESCE(SUM(ledger.input_tokens), 0) AS inputTokens,
             COALESCE(SUM(ledger.output_tokens), 0) AS outputTokens,
             COALESCE(SUM(ledger.cost_usd), 0) AS ledgerCostUsd,
             MIN(ledger.provider) AS provider, MIN(ledger.model) AS model,
             COUNT(DISTINCT ledger.provider) AS providers,
             COUNT(DISTINCT ledger.model) AS models
      FROM model_budget_reservations AS reservation
      LEFT JOIN cost_ledger AS ledger
        ON ledger.exploration_run_id = reservation.exploration_run_id
       AND ledger.category = 'strategy-exploration'
      WHERE reservation.exploration_run_id = ? GROUP BY reservation.id
    `).get(receipt.payload.healing.explorationRunId) as Record<string, unknown> | undefined;
    if (cost === undefined
      || cost.reservationStatus !== receipt.payload.cost.reservationStatus
      || cost.reservationAmountUsd !== receipt.payload.cost.reservationAmountUsd
      || cost.actualCostUsd !== receipt.payload.cost.actualCostUsd
      || cost.ledgerRows !== receipt.payload.cost.ledgerRows
      || cost.inputTokens !== receipt.payload.cost.inputTokens
      || cost.outputTokens !== receipt.payload.cost.outputTokens
      || cost.ledgerCostUsd !== receipt.payload.cost.actualCostUsd
      || cost.provider !== "codex-sdk" || cost.model !== receipt.payload.cost.model
      || cost.providers !== 1 || cost.models !== 1) {
      throw new Error("Healing cost reservation or ledger differs from its receipt");
    }
    const successor = database.prepare(`
      SELECT version, strategy_json AS strategyJson, active
      FROM strategies WHERE id = ? AND retailer_id = ? AND purpose = 'extraction'
    `).get(
      receipt.payload.healing.successorStrategyId,
      receipt.payload.staging.disposableRetailerId,
    ) as { version: number; strategyJson: string; active: number } | undefined;
    if (successor === undefined || successor.active !== 1
      || successor.version !== receipt.payload.healing.successorStrategyVersion) {
      throw new Error("Healing successor activation differs from the receipt");
    }
    const receiptFile = resolve(
      dirname(stagingDatabasePath),
      "runtime",
      receipt.payload.validation.receiptPath,
    );
    const evidence = readStrategyValidationEvidence(receiptFile, {
      retailerId: receipt.payload.staging.disposableRetailerId,
      purpose: "extraction",
      strategyVersion: successor.version,
      strategy: JSON.parse(successor.strategyJson),
      verificationPublicKey: publicKey,
      authoritativeRefs: listStrategyValidationRefs(
        database,
        receipt.payload.staging.disposableRetailerId,
        30,
      ),
    });
    if (validationReceiptSha256(evidence) !== receipt.payload.validation.receiptSha256
      || evidence.sampleSetSha256 !== receipt.payload.validation.sampleSetSha256
      || evidence.attempted !== 30 || evidence.valid !== receipt.payload.validation.valid
      || evidence.score !== receipt.payload.validation.score
      || evidence.executor.mode !== "trusted-live-host"
      || evidence.executor.sourceCommit !== receipt.payload.release.sourceCommit
      || evidence.executor.artifactSha256 !== receipt.payload.validation.validatorArtifactSha256
      || evidence.executor.challengeAlgorithm !== receipt.payload.validation.challengeAlgorithm) {
      throw new Error("Trusted successor validation receipt differs from drill evidence");
    }
    validateHealingSabotageRetainedBindings({
      database,
      receipt,
      stagingDatabasePath,
      successorEvidence: evidence,
    });
  } finally {
    database.close();
  }
  return receipt;
}

function parseCli(args: readonly string[]): HealingSabotageDrillOptions {
  if (args[0] !== "run") {
    throw new Error(
      "usage: healing-drill run --project-root PATH --database PATH --release-path PATH "
      + "--public-key PATH --private-key PATH --confirm-staging-sabotage "
      + "--authorize-live-spend-usd N",
    );
  }
  const values = new Map<string, string>();
  const valuedArguments = new Set([
    "--project-root",
    "--database",
    "--release-path",
    "--public-key",
    "--private-key",
    "--authorize-live-spend-usd",
  ]);
  let confirmed = false;
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--confirm-staging-sabotage") {
      if (confirmed) throw new Error(`${name} was provided more than once`);
      confirmed = true;
      continue;
    }
    if (name === undefined || !valuedArguments.has(name)) {
      throw new Error(`Unknown healing drill argument: ${name ?? "<missing>"}`);
    }
    if (values.has(name)) throw new Error(`${name} was provided more than once`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`${name} is required`);
    return value;
  };
  return {
    projectRoot: required("--project-root"),
    databasePath: required("--database"),
    releasePath: required("--release-path"),
    publicKeyPath: required("--public-key"),
    privateKeyPath: required("--private-key"),
    confirmStagingSabotage: confirmed,
    authorizedSpendUsd: Number(required("--authorize-live-spend-usd")),
  };
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await runHealingSabotageDrill(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`healing-drill: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
