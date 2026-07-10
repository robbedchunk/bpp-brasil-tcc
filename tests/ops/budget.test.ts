import { describe, expect, it } from "vitest";

import { BudgetGuard } from "../../src/ops/budget.js";

describe("budget guard", () => {
  it("pauses only nonessential LLM work above the monthly ceiling", () => {
    const budgetGuard = new BudgetGuard(50);

    expect(budgetGuard.decide({ projectedMonthlyUsd: 50.01, essential: false })).toBe("pause");
    expect(budgetGuard.decide({ projectedMonthlyUsd: 99, essential: true })).toBe("continue");
    expect(budgetGuard.decide({ projectedMonthlyUsd: 50, essential: false })).toBe("continue");
  });
});
