import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type { KeyObject } from "node:crypto";

import { StrategySchema } from "../strategies/schema.js";
import {
  canonicalEvidenceJson,
  readTrustedValidatorArtifactSha256,
  readValidationVerificationPublicKey,
  validateStrategyEvidence,
  validationReceiptSha256,
  type StrategyValidationEvidence,
} from "../strategies/validation-evidence.js";
import {
  selectStrategyValidationChallenge,
  VALIDATION_CHALLENGE_ALGORITHM,
} from "../strategies/validation-challenge.js";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const APPEND_ONLY_SQL = readFileSync(
  new URL("./migrations/002_append_only.sql", import.meta.url),
  "utf8",
);
const IPCA_PROVENANCE_SQL = readFileSync(
  new URL("./migrations/003_ipca_provenance.sql", import.meta.url),
  "utf8",
);
const CLASSIFICATION_AUDIT_SQL = readFileSync(
  new URL("./migrations/004_classification_audit.sql", import.meta.url),
  "utf8",
);
const BATCH_COMMITMENTS_SQL = readFileSync(
  new URL("./migrations/005_batch_commitments.sql", import.meta.url),
  "utf8",
);
const EXPLORATION_ATTEMPT_EVIDENCE_SQL = readFileSync(
  new URL("./migrations/006_exploration_attempt_evidence.sql", import.meta.url),
  "utf8",
);
const HEALING_EVENT_IDEMPOTENCY_SQL = readFileSync(
  new URL("./migrations/007_healing_event_idempotency.sql", import.meta.url),
  "utf8",
);
const HEALING_WORKER_BUDGET_RESERVATIONS_SQL = readFileSync(
  new URL("./migrations/008_healing_worker_budget_reservations.sql", import.meta.url),
  "utf8",
);
const HEALING_EXPLORATION_RECOVERY_SQL = readFileSync(
  new URL("./migrations/009_healing_exploration_recovery.sql", import.meta.url),
  "utf8",
);
const EXPLORATION_RECOVERY_ADJUSTMENTS_SQL = readFileSync(
  new URL("./migrations/010_exploration_recovery_adjustments.sql", import.meta.url),
  "utf8",
);
const COLLECTION_INTEGRITY_SQL = readFileSync(
  new URL("./migrations/011_collection_integrity.sql", import.meta.url),
  "utf8",
);
const RETAILER_STATE_HISTORY_SQL = readFileSync(
  new URL("./migrations/012_retailer_state_history.sql", import.meta.url),
  "utf8",
);
const STRATEGY_VALIDATION_EVIDENCE_SQL = readFileSync(
  new URL("./migrations/013_strategy_validation_evidence.sql", import.meta.url),
  "utf8",
);
const STRATEGY_VALIDATION_AUTHORIZATION_SQL = readFileSync(
  new URL("./migrations/014_strategy_validation_authorization.sql", import.meta.url),
  "utf8",
);
const RUNTIME_SAFETY_RECONCILIATION_SQL = readFileSync(
  new URL("./migrations/015_runtime_safety_reconciliation.sql", import.meta.url),
  "utf8",
);
const DISCOVERY_TIER_SEMANTICS_SQL = readFileSync(
  new URL("./migrations/016_discovery_tier_semantics.sql", import.meta.url),
  "utf8",
);
const OPERATOR_CATALOG_SEEDS_SQL = readFileSync(
  new URL("./migrations/017_operator_catalog_seeds.sql", import.meta.url),
  "utf8",
);
const CLASSIFICATION_SHAPE_RECOVERY_SQL = readFileSync(
  new URL("./migrations/018_classification_shape_recovery.sql", import.meta.url),
  "utf8",
);
const CLASSIFICATION_MEASUREMENT_SCOPE_SQL = readFileSync(
  new URL("./migrations/019_classification_measurement_scope.sql", import.meta.url),
  "utf8",
);
const PRODUCT_URL_IDENTITY_SQL = readFileSync(
  new URL("./migrations/020_product_url_identity.sql", import.meta.url),
  "utf8",
);

export interface StrategyValidationEvidenceInsert {
  strategy_id: string;
  receipt_path: string;
  receipt_sha256: string;
  sample_set_sha256: string;
  executor_json: string;
  attestation_key_id: string;
  attempted: number;
  valid: number;
  score: number;
  validated_at: string;
  recorded_at: string;
}

const validationEvidenceAuthorizations = new WeakMap<
  Database.Database,
  Set<string>
>();

function validationEvidenceAuthorizationKey(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

function validationEvidenceValues(
  evidence: StrategyValidationEvidenceInsert,
): readonly unknown[] {
  return [
    evidence.strategy_id,
    evidence.receipt_path,
    evidence.receipt_sha256,
    evidence.sample_set_sha256,
    evidence.executor_json,
    evidence.attestation_key_id,
    evidence.attempted,
    evidence.valid,
    evidence.score,
    evidence.validated_at,
    evidence.recorded_at,
  ];
}

function registerValidationEvidenceAuthorization(
  database: Database.Database,
): void {
  if (validationEvidenceAuthorizations.has(database)) return;

  const pending = new Set<string>();
  validationEvidenceAuthorizations.set(database, pending);
  database.function(
    "validation_evidence_insert_authorized",
    { varargs: true },
    (...values: unknown[]) => pending.delete(
      validationEvidenceAuthorizationKey(values),
    ) ? 1 : 0,
  );
}

/**
 * Grants a one-shot authorization for an exact evidence row. Callers must have
 * already verified the signed receipt and trusted executor. The database
 * trigger consumes this authorization, so raw SQL and replayed inserts fail.
 */
function withAuthorizedStrategyValidationEvidenceInsert<T>(
  database: Database.Database,
  evidence: StrategyValidationEvidenceInsert,
  operation: () => T,
): T {
  registerValidationEvidenceAuthorization(database);
  const pending = validationEvidenceAuthorizations.get(database);
  if (pending === undefined) {
    throw new Error("Strategy validation authorization is unavailable");
  }
  const key = validationEvidenceAuthorizationKey(validationEvidenceValues(evidence));
  if (pending.has(key)) {
    throw new Error("Strategy validation evidence is already authorized");
  }

  pending.add(key);
  try {
    const result = operation();
    if (pending.has(key)) {
      throw new Error("Strategy validation evidence authorization was not consumed");
    }
    return result;
  } finally {
    pending.delete(key);
  }
}

export function insertVerifiedStrategyValidationEvidence(
  database: Database.Database,
  input: {
    strategyId: string;
    receiptPath: string;
    receiptSha256: string;
    evidence: StrategyValidationEvidence;
    testVerificationPublicKey?: KeyObject;
    recordedAt?: string;
  },
): void {
  const testKey = input.testVerificationPublicKey;
  const inMemory = database.name === ":memory:" || database.name === "";
  if (testKey !== undefined && !inMemory) {
    throw new Error("A caller-supplied validation key is forbidden for file-backed evidence");
  }
  const strategy = database.prepare(`
    SELECT id, retailer_id, purpose, version, strategy_json, active,
           validation_sample_size, validation_successes, validation_rate,
           validated_at
    FROM strategies WHERE id = ?
  `).get(input.strategyId) as {
      id: string;
      retailer_id: string;
      purpose: "discovery" | "extraction";
      version: number;
      strategy_json: string;
      active: number;
      validation_sample_size: number;
      validation_successes: number;
      validation_rate: number | null;
      validated_at: string | null;
    } | undefined;
  if (strategy === undefined || strategy.active !== 0) {
    throw new Error("Validation evidence requires its exact inactive strategy row");
  }
  const expectedPath = `data/validation/${strategy.retailer_id}-${strategy.purpose}-v${strategy.version}.json`;
  const challenge = selectStrategyValidationChallenge(database, strategy.retailer_id, 30);
  if (challenge.length !== 30 && !(inMemory && testKey !== undefined && challenge.length === 0)) {
    throw new Error("Validation evidence requires 30 independent active in-scope references");
  }
  const verificationPublicKey = testKey ?? readValidationVerificationPublicKey(
    new URL("../../ops/validation-attestation-public.pem", import.meta.url).pathname,
  );
  const evidence = validateStrategyEvidence(input.evidence, {
    retailerId: strategy.retailer_id,
    purpose: strategy.purpose,
    strategyVersion: strategy.version,
    strategy: StrategySchema.parse(JSON.parse(strategy.strategy_json)),
    verificationPublicKey,
    ...(challenge.length === 0 ? {} : { authoritativeRefs: challenge }),
  });
  if (
    (challenge.length > 0
      && canonicalEvidenceJson(evidence.samples.map(({ ref }) => ref))
        !== canonicalEvidenceJson(challenge))
    || (testKey === undefined
      && (
        evidence.executor.artifactSha256 !== readTrustedValidatorArtifactSha256()
        || evidence.executor.challengeAlgorithm !== VALIDATION_CHALLENGE_ALGORITHM
      ))
    || evidence.activatable !== true
    || evidence.executor.mode !== "trusted-live-host"
    || evidence.attempted !== 30
    || evidence.valid < 27
    || input.receiptPath !== expectedPath
    || input.receiptSha256 !== validationReceiptSha256(evidence)
    || strategy.validation_sample_size !== evidence.attempted
    || strategy.validation_successes !== evidence.valid
    || strategy.validation_rate !== evidence.score
    || strategy.validated_at !== evidence.validatedAt
  ) {
    throw new Error("Validation evidence failed the signed trusted activation boundary");
  }
  const recordedAt = input.recordedAt ?? new Date(Math.max(
    Date.now(),
    Date.parse(evidence.validatedAt),
  )).toISOString();
  const row: StrategyValidationEvidenceInsert = {
    strategy_id: strategy.id,
    receipt_path: input.receiptPath,
    receipt_sha256: input.receiptSha256,
    sample_set_sha256: evidence.sampleSetSha256,
    executor_json: JSON.stringify(evidence.executor),
    attestation_key_id: evidence.attestation.keyId,
    attempted: evidence.attempted,
    valid: evidence.valid,
    score: evidence.score,
    validated_at: evidence.validatedAt,
    recorded_at: recordedAt,
  };
  withAuthorizedStrategyValidationEvidenceInsert(database, row, () => {
    database.prepare(`
      INSERT INTO strategy_validation_evidence
        (strategy_id, receipt_path, receipt_sha256, sample_set_sha256,
         executor_json, attestation_key_id, attempted, valid, score,
         validated_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...validationEvidenceValues(row));
  });
}

/** Test fixtures only: production file-backed databases can never use this capability. */
export function insertTestStrategyValidationEvidenceRow(
  database: Database.Database,
  evidence: StrategyValidationEvidenceInsert,
): void {
  if (
    (database.name !== ":memory:" && database.name !== "")
    || process.env.VITEST !== "true"
  ) {
    throw new Error("Test validation evidence rows are restricted to Vitest in-memory databases");
  }
  withAuthorizedStrategyValidationEvidenceInsert(database, evidence, () => {
    database.prepare(`
      INSERT INTO strategy_validation_evidence
        (strategy_id, receipt_path, receipt_sha256, sample_set_sha256,
         executor_json, attestation_key_id, attempted, valid, score,
         validated_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...validationEvidenceValues(evidence));
  });
}

const MIGRATIONS = [
  { version: 1, name: "m0_foundation", sql: SCHEMA_SQL },
  { version: 2, name: "append_only_evidence", sql: APPEND_ONLY_SQL },
  { version: 3, name: "ipca_item_provenance", sql: IPCA_PROVENANCE_SQL },
  { version: 4, name: "classification_audit", sql: CLASSIFICATION_AUDIT_SQL },
  { version: 5, name: "batch_commitments", sql: BATCH_COMMITMENTS_SQL },
  {
    version: 6,
    name: "exploration_attempt_evidence",
    sql: EXPLORATION_ATTEMPT_EVIDENCE_SQL,
  },
  {
    version: 7,
    name: "healing_event_idempotency",
    sql: HEALING_EVENT_IDEMPOTENCY_SQL,
  },
  {
    version: 8,
    name: "healing_worker_budget_reservations",
    sql: HEALING_WORKER_BUDGET_RESERVATIONS_SQL,
  },
  {
    version: 9,
    name: "healing_exploration_recovery",
    sql: HEALING_EXPLORATION_RECOVERY_SQL,
  },
  {
    version: 10,
    name: "exploration_recovery_adjustments",
    sql: EXPLORATION_RECOVERY_ADJUSTMENTS_SQL,
  },
  {
    version: 11,
    name: "collection_integrity",
    sql: COLLECTION_INTEGRITY_SQL,
  },
  {
    version: 12,
    name: "retailer_state_history",
    sql: RETAILER_STATE_HISTORY_SQL,
  },
  {
    version: 13,
    name: "strategy_validation_evidence",
    sql: STRATEGY_VALIDATION_EVIDENCE_SQL,
  },
  {
    version: 14,
    name: "strategy_validation_authorization",
    sql: STRATEGY_VALIDATION_AUTHORIZATION_SQL,
  },
  {
    version: 15,
    name: "runtime_safety_reconciliation",
    sql: RUNTIME_SAFETY_RECONCILIATION_SQL,
  },
  {
    version: 16,
    name: "discovery_tier_semantics",
    sql: DISCOVERY_TIER_SEMANTICS_SQL,
  },
  {
    version: 17,
    name: "operator_catalog_seeds",
    sql: OPERATOR_CATALOG_SEEDS_SQL,
  },
  {
    version: 18,
    name: "classification_shape_recovery",
    sql: CLASSIFICATION_SHAPE_RECOVERY_SQL,
  },
  {
    version: 19,
    name: "classification_measurement_scope",
    sql: CLASSIFICATION_MEASUREMENT_SCOPE_SQL,
  },
  {
    version: 20,
    name: "product_url_identity",
    sql: PRODUCT_URL_IDENTITY_SQL,
  },
] as const;

export const EXPECTED_SCHEMA_MIGRATIONS: readonly {
  version: number;
  name: string;
}[] = MIGRATIONS.map(({ version, name }) => ({ version, name }));

export function migrate(database: Database.Database): void {
  registerValidationEvidenceAuthorization(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const findMigration = database.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = ?",
  );
  const recordMigration = database.prepare(
    `INSERT INTO schema_migrations (version, name, applied_at)
     VALUES (?, ?, ?)`,
  );
  const applyPendingMigrations = database.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (findMigration.get(migration.version) !== undefined) {
        continue;
      }

      database.exec(migration.sql);
      recordMigration.run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
  });

  applyPendingMigrations.immediate();
}

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const database = new Database(path);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("recursive_triggers = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    migrate(database);

    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
