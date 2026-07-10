import { Decimal } from "decimal.js";
import type Database from "better-sqlite3";

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
         AND status NOT IN (${releasedPlaceholders})) AS committed
  `).get(
    monthStart,
    nextMonth,
    ...RELEASED_CLASSIFICATION_BATCH_STATUSES,
  ) as { committed: number };
  return row.committed;
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
