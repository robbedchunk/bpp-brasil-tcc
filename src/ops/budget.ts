import { Decimal } from "decimal.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const RELEASED_CLASSIFICATION_BATCH_STATUSES = [
  "finalize_failed",
  "submission_released",
] as const;

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
       WHERE status = 'reserved' AND month_start = ?) AS committed
  `).get(
    monthStart,
    nextMonth,
    ...RELEASED_CLASSIFICATION_BATCH_STATUSES,
    monthStart,
  ) as { committed: number };
  return row.committed;
}

export interface ExplorationBudgetReservationDecision {
  reserved: boolean;
  explorationRunId: string;
  amountUsd: number;
  committedBeforeUsd: number;
}

function validUsd(name: string, value: number, allowZero = false): void {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} finite number`);
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
  validUsd("eventAllowanceUsd", input.eventAllowanceUsd);
  validUsd("monthlyLimitUsd", input.monthlyLimitUsd, true);
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
  validUsd("actualCostUsd", input.actualCostUsd, true);
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
