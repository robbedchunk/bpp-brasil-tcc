import { describe, expect, it } from "vitest";

import { BudgetGuard } from "../../src/ops/budget.js";

describe("budget guard", () => {
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
