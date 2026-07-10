export type BudgetDecision = "continue" | "pause";

export interface BudgetProjection {
  projectedMonthlyUsd: number;
  essential: boolean;
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
}
