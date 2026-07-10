import { Decimal } from "decimal.js";

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
