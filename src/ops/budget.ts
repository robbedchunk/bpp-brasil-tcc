import { Decimal } from "decimal.js";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

export const RELEASED_CLASSIFICATION_BATCH_STATUSES = [
  "finalize_failed",
  "submission_released",
] as const;
export const MAX_EXPLORATION_EVENT_USD = 5;
export const MAX_MONTHLY_MODEL_USD = 50;

export function monthlyModelBudgetUsdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = env.PRECOS_MONTHLY_MODEL_USD?.trim();
  if (value === undefined || value.length === 0) return MAX_MONTHLY_MODEL_USD;
  const budgetUsd = Number(value);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error("PRECOS_MONTHLY_MODEL_USD must be a positive finite number");
  }
  return budgetUsd;
}

export function classificationMonthlyCommittedUsd(
  database: Database.Database,
  now: Date,
): number {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const releasedPlaceholders = RELEASED_CLASSIFICATION_BATCH_STATUSES.map(() => "?").join(", ");
  const row = database.prepare(`
    SELECT
      (SELECT COALESCE(SUM(cost_usd), 0)
       FROM cost_ledger
       WHERE occurred_at >= ? AND occurred_at < ?)
      +
      (SELECT COALESCE(SUM(
         CASE
           WHEN actual_cost_usd IS NOT NULL THEN actual_cost_usd
           ELSE projected_cost_usd
         END
       ), 0)
      FROM classification_batch_jobs
       WHERE status NOT LIKE 'finalized%'
         AND status NOT IN (${releasedPlaceholders}))
      +
      (SELECT COALESCE(SUM(amount_usd), 0)
       FROM model_budget_reservations
       WHERE status = 'reserved')
      +
      (SELECT COALESCE(SUM(projected_cost_usd), 0)
       FROM classification_sync_reservations
       WHERE status = 'reserved') AS committed
  `).get(
    monthStart,
    nextMonth,
    ...RELEASED_CLASSIFICATION_BATCH_STATUSES,
  ) as { committed: number };
  return row.committed;
}

export interface ExplorationBudgetReservationDecision {
  reserved: boolean;
  explorationRunId: string;
  amountUsd: number;
  committedBeforeUsd: number;
}

export interface SynchronousClassificationReservationDecision {
  reserved: boolean;
  reservationId: string | null;
  projectedCostUsd: number;
  committedBeforeUsd: number;
}

function classificationRequestSha256(input: {
  version: number;
  model: string;
  productIds: readonly string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: input.version,
    model: input.model,
    productIds: input.productIds,
  })).digest("hex");
}

/** Atomically checks the monthly budget and persists a paid-call reservation
 * before a synchronous provider request may begin. */
export function reserveSynchronousClassificationBudget(
  database: Database.Database,
  input: {
    version: number;
    model: string;
    productIds: readonly string[];
    projectedCostUsd: number;
    now: Date;
    budgetGuard: BudgetGuard;
  },
): SynchronousClassificationReservationDecision {
  if (!Number.isSafeInteger(input.version) || input.version <= 0) {
    throw new RangeError("classification version must be a positive safe integer");
  }
  if (input.model.trim().length === 0) throw new Error("classification model is required");
  if (input.productIds.length === 0
    || new Set(input.productIds).size !== input.productIds.length
    || input.productIds.some((id) => id.trim().length === 0)) {
    throw new Error("classification reservation requires unique product IDs");
  }
  if (!Number.isFinite(input.projectedCostUsd) || input.projectedCostUsd <= 0) {
    throw new RangeError("projected classification cost must be positive");
  }
  if (!Number.isFinite(input.now.getTime())) throw new RangeError("now must be valid");

  return database.transaction((): SynchronousClassificationReservationDecision => {
    const committedBeforeUsd = classificationMonthlyCommittedUsd(database, input.now);
    if (input.budgetGuard.decide({
      projectedMonthlyUsd: new Decimal(committedBeforeUsd)
        .plus(input.projectedCostUsd)
        .toNumber(),
      essential: false,
    }) === "pause") {
      return {
        reserved: false,
        reservationId: null,
        projectedCostUsd: input.projectedCostUsd,
        committedBeforeUsd,
      };
    }
    const reservationId = randomUUID();
    database.prepare(`
      INSERT INTO classification_sync_reservations
        (id, request_sha256, version, model, product_ids_json,
         projected_cost_usd, status, month_start, reserved_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
    `).run(
      reservationId,
      classificationRequestSha256(input),
      input.version,
      input.model,
      JSON.stringify(input.productIds),
      input.projectedCostUsd,
      monthStartIso(input.now),
      input.now.toISOString(),
      JSON.stringify({
        committedBeforeUsd,
        boundary: "before-provider-request",
      }),
    );
    return {
      reserved: true,
      reservationId,
      projectedCostUsd: input.projectedCostUsd,
      committedBeforeUsd,
    };
  }).immediate();
}

export function settleSynchronousClassificationBudget(
  database: Database.Database,
  input: {
    reservationId: string;
    actualCostUsd: number;
    settledAt: string;
    status?: "settled" | "recovered" | "released";
    details?: Record<string, unknown>;
  },
): void {
  if (!Number.isFinite(input.actualCostUsd) || input.actualCostUsd < 0) {
    throw new RangeError("actual classification cost must be non-negative");
  }
  if (!Number.isFinite(Date.parse(input.settledAt))) {
    throw new RangeError("classification settlement timestamp is invalid");
  }
  const status = input.status ?? (input.actualCostUsd === 0 ? "released" : "settled");
  const result = database.prepare(`
    UPDATE classification_sync_reservations
    SET status = ?, actual_cost_usd = ?, settled_at = ?,
        details_json = json_patch(details_json, ?)
    WHERE id = ? AND status = 'reserved'
  `).run(
    status,
    input.actualCostUsd,
    input.settledAt,
    JSON.stringify({
      actualCostUsd: input.actualCostUsd,
      ...(input.details ?? {}),
    }),
    input.reservationId,
  );
  if (result.changes !== 1) {
    throw new Error(`Synchronous classification reservation ${input.reservationId} is not active`);
  }
}

/** Exclusive-lock startup recovery. The full projection remains charged
 * because SIGKILL can erase the provider response while the remote request was
 * already billable. */
export function reconcileSynchronousClassificationReservations(
  database: Database.Database,
  reconciledAt: string,
): string[] {
  if (!Number.isFinite(Date.parse(reconciledAt))) {
    throw new RangeError("classification reconciliation timestamp is invalid");
  }
  return database.transaction((): string[] => {
    const rows = database.prepare(`
      SELECT id, request_sha256, version, model, product_ids_json,
             projected_cost_usd, reserved_at
      FROM classification_sync_reservations
      WHERE status = 'reserved'
      ORDER BY reserved_at, id
    `).all() as Array<{
      id: string;
      request_sha256: string;
      version: number;
      model: string;
      product_ids_json: string;
      projected_cost_usd: number;
      reserved_at: string;
    }>;
    for (const row of rows) {
      const ledgerId = randomUUID();
      const details = {
        reservationId: row.id,
        requestSha256: row.request_sha256,
        version: row.version,
        productIds: JSON.parse(row.product_ids_json) as unknown,
        reservedAt: row.reserved_at,
        reason: "interrupted-synchronous-provider-request",
        estimateSource: "full-durable-pre-request-reservation",
      };
      database.prepare(`
        INSERT INTO cost_ledger
          (id, category, classification_reservation_id, provider, model,
           input_tokens, output_tokens, cost_usd, occurred_at, details_json)
        VALUES (?, 'classification-recovery', ?, 'internal-recovery', ?,
                0, 0, ?, ?, ?)
      `).run(
        ledgerId,
        row.id,
        row.model,
        row.projected_cost_usd,
        reconciledAt,
        JSON.stringify(details),
      );
      settleSynchronousClassificationBudget(database, {
        reservationId: row.id,
        actualCostUsd: row.projected_cost_usd,
        settledAt: reconciledAt,
        status: "recovered",
        details: {
          reconciled: true,
          recoveryLedgerId: ledgerId,
          estimateSource: "full-durable-pre-request-reservation",
        },
      });
      database.prepare(`
        INSERT INTO runtime_reconciliations
          (id, kind, subject_id, classification_reservation_id,
           reconciled_at, details_json)
        VALUES (?, 'classification-reservation', ?, ?, ?, ?)
      `).run(randomUUID(), row.id, row.id, reconciledAt, JSON.stringify(details));
    }
    return rows.map(({ id }) => id);
  }).immediate();
}

function validUsd(name: string, value: number, maximum: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be positive and at most USD ${maximum}`);
  }
}

function positiveUsd(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
}

function monthStartIso(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError("now must be a valid date");
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function reserveExplorationBudget(
  database: Database.Database,
  input: {
    explorationRunId: string;
    retailerId: string;
    eventAllowanceUsd: number;
    monthlyLimitUsd: number;
    now: Date;
  },
): ExplorationBudgetReservationDecision {
  validUsd("eventAllowanceUsd", input.eventAllowanceUsd, MAX_EXPLORATION_EVENT_USD);
  positiveUsd("monthlyLimitUsd", input.monthlyLimitUsd);
  const reserve = database.transaction((): ExplorationBudgetReservationDecision => {
    const existing = database.prepare(
      `SELECT amount_usd, status FROM model_budget_reservations
       WHERE exploration_run_id = ?`,
    ).get(input.explorationRunId) as { amount_usd: number; status: string } | undefined;
    if (existing !== undefined) {
      return {
        reserved: existing.status === "reserved",
        explorationRunId: input.explorationRunId,
        amountUsd: existing.amount_usd,
        committedBeforeUsd: classificationMonthlyCommittedUsd(database, input.now)
          - (existing.status === "reserved" ? existing.amount_usd : 0),
      };
    }
    const committedBeforeUsd = classificationMonthlyCommittedUsd(database, input.now);
    if (new Decimal(committedBeforeUsd).plus(input.eventAllowanceUsd)
      .greaterThan(input.monthlyLimitUsd)) {
      return {
        reserved: false,
        explorationRunId: input.explorationRunId,
        amountUsd: input.eventAllowanceUsd,
        committedBeforeUsd,
      };
    }
    const reservedAt = input.now.toISOString();
    database.prepare(
      `INSERT INTO model_budget_reservations
         (id, category, retailer_id, exploration_run_id, amount_usd,
          status, month_start, reserved_at, details_json)
       VALUES (?, 'strategy-exploration', ?, ?, ?, 'reserved', ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.retailerId,
      input.explorationRunId,
      input.eventAllowanceUsd,
      monthStartIso(input.now),
      reservedAt,
      JSON.stringify({ monthlyLimitUsd: input.monthlyLimitUsd, committedBeforeUsd }),
    );
    return {
      reserved: true,
      explorationRunId: input.explorationRunId,
      amountUsd: input.eventAllowanceUsd,
      committedBeforeUsd,
    };
  });
  return reserve.immediate();
}

export function settleExplorationBudget(
  database: Database.Database,
  input: {
    explorationRunId: string;
    actualCostUsd: number;
    settledAt: string;
    release?: boolean;
  },
): void {
  if (!Number.isFinite(input.actualCostUsd) || input.actualCostUsd < 0) {
    throw new RangeError("actualCostUsd must be a non-negative finite number");
  }
  if (!Number.isFinite(Date.parse(input.settledAt))) {
    throw new RangeError("settledAt must be an ISO timestamp");
  }
  const result = database.prepare(
    `UPDATE model_budget_reservations
     SET status = ?, actual_cost_usd = ?, settled_at = ?,
         details_json = json_set(details_json, '$.actualCostUsd', ?)
     WHERE exploration_run_id = ? AND status = 'reserved'`,
  ).run(
    input.release === true ? "released" : "settled",
    input.actualCostUsd,
    input.settledAt,
    input.actualCostUsd,
    input.explorationRunId,
  );
  if (result.changes === 0) {
    const existing = database.prepare(
      "SELECT status FROM model_budget_reservations WHERE exploration_run_id = ?",
    ).get(input.explorationRunId) as { status: string } | undefined;
    if (existing === undefined) {
      throw new Error(`Exploration budget reservation ${input.explorationRunId} was not found`);
    }
  }
}

export type BudgetDecision = "continue" | "pause";

export interface BudgetProjection {
  projectedMonthlyUsd: number;
  essential: boolean;
}

export interface ModelTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export const MODEL_PRICE_REFERENCE_DATE = "2026-07-10";

// Budgeting estimates, not provider invoices. Unknown compatible models use
// the same conservative fallback so an unrecognized model never bypasses the cap.
export const MODEL_PRICES_USD_PER_MILLION: Readonly<Record<string, ModelPrice>> = {
  "gpt-5.6-luna": {
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 15,
  },
};

const FALLBACK_MODEL_PRICE: ModelPrice = {
  inputUsdPerMillion: 2.5,
  outputUsdPerMillion: 15,
};

function validTokenCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export class BudgetGuard {
  readonly #monthlyLimitUsd: number;

  /** Default guard for paid model work: honors PRECOS_MONTHLY_MODEL_USD. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): BudgetGuard {
    return new BudgetGuard(monthlyModelBudgetUsdFromEnv(env));
  }

  constructor(monthlyLimitUsd = 50) {
    if (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0) {
      throw new RangeError("monthlyLimitUsd must be a non-negative finite number");
    }
    this.#monthlyLimitUsd = monthlyLimitUsd;
  }

  decide(projection: BudgetProjection): BudgetDecision {
    if (!Number.isFinite(projection.projectedMonthlyUsd) || projection.projectedMonthlyUsd < 0) {
      throw new RangeError("projectedMonthlyUsd must be a non-negative finite number");
    }
    return !projection.essential && projection.projectedMonthlyUsd > this.#monthlyLimitUsd
      ? "pause"
      : "continue";
  }

  estimateModelCost(usage: ModelTokenUsage): number {
    validTokenCount("inputTokens", usage.inputTokens);
    validTokenCount("outputTokens", usage.outputTokens);
    const price = MODEL_PRICES_USD_PER_MILLION[usage.model] ?? FALLBACK_MODEL_PRICE;
    return new Decimal(usage.inputTokens)
      .mul(price.inputUsdPerMillion)
      .plus(new Decimal(usage.outputTokens).mul(price.outputUsdPerMillion))
      .div(1_000_000)
      .toDecimalPlaces(12)
      .toNumber();
  }
}
