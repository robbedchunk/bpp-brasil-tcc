import { describe, expect, it } from "vitest";

import { BudgetGuard, monthlyModelBudgetUsdFromEnv } from "../../src/ops/budget.js";

describe("budget guard", () => {
  it("defaults the monthly model budget to USD 50 and validates operator overrides", () => {
    expect(monthlyModelBudgetUsdFromEnv({})).toBe(50);
    expect(monthlyModelBudgetUsdFromEnv({ PRECOS_MONTHLY_MODEL_USD: "125.5" }))
      .toBe(125.5);
    for (const value of ["0", "-1", "Infinity", "not-a-number"]) {
      expect(() => monthlyModelBudgetUsdFromEnv({ PRECOS_MONTHLY_MODEL_USD: value }))
        .toThrow(/positive finite number/iu);
    }
  });

  it("builds default guards that honor the operator monthly override", () => {
    const betweenDefaultAndOverride = { projectedMonthlyUsd: 75, essential: false };

    expect(BudgetGuard.fromEnv({ PRECOS_MONTHLY_MODEL_USD: "100" })
      .decide(betweenDefaultAndOverride)).toBe("continue");
    expect(BudgetGuard.fromEnv({}).decide(betweenDefaultAndOverride)).toBe("pause");
    expect(() => BudgetGuard.fromEnv({ PRECOS_MONTHLY_MODEL_USD: "not-a-number" }))
      .toThrow(/positive finite number/iu);
  });

  it("pauses only nonessential LLM work above the monthly ceiling", () => {
    const budgetGuard = new BudgetGuard(50);

    expect(budgetGuard.decide({ projectedMonthlyUsd: 50.01, essential: false })).toBe("pause");
    expect(budgetGuard.decide({ projectedMonthlyUsd: 99, essential: true })).toBe("continue");
    expect(budgetGuard.decide({ projectedMonthlyUsd: 50, essential: false })).toBe("continue");
  });

  it("estimates classification token cost with the dated model price table", () => {
    const budgetGuard = new BudgetGuard(50);

    expect(budgetGuard.estimateModelCost({
      model: "gpt-5.6-luna",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })).toBe(17.5);
    expect(budgetGuard.estimateModelCost({
      model: "unknown-compatible-model",
      inputTokens: 1_000,
      outputTokens: 100,
    })).toBeGreaterThan(0);
  });
});
