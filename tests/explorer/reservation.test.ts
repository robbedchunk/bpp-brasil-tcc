import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { beginExplorationRun } from "../../src/db/repositories.js";
import {
  classificationMonthlyCommittedUsd,
  reserveExplorationBudget,
  settleExplorationBudget,
} from "../../src/ops/budget.js";
import { seedRetailer } from "../pipeline/helpers.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const directories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("exploration budget reservations", () => {
  it("atomically admits only one concurrent USD 5 event under a USD 5 monthly limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "explorer-reservation-"));
    directories.push(directory);
    const path = join(directory, "evidence.sqlite");
    const first = openDatabase(path);
    const second = openDatabase(path);
    databases.push(first, second);
    seedRetailer(first, "first");
    seedRetailer(first, "second");
    const now = new Date("2026-07-10T12:00:00.000Z");
    const firstRun = beginExplorationRun(first, {
      retailerId: "first",
      purpose: "extraction",
      trigger: "test",
      maxAttempts: 1,
      startedAt: now.toISOString(),
    });
    const secondRun = beginExplorationRun(first, {
      retailerId: "second",
      purpose: "extraction",
      trigger: "test",
      maxAttempts: 1,
      startedAt: now.toISOString(),
    });

    const [left, right] = await Promise.all([
      new Promise<ReturnType<typeof reserveExplorationBudget>>((resolve) =>
        setImmediate(() => resolve(reserveExplorationBudget(first, {
          explorationRunId: firstRun,
          retailerId: "first",
          eventAllowanceUsd: 5,
          monthlyLimitUsd: 5,
          now,
        })))),
      new Promise<ReturnType<typeof reserveExplorationBudget>>((resolve) =>
        setImmediate(() => resolve(reserveExplorationBudget(second, {
          explorationRunId: secondRun,
          retailerId: "second",
          eventAllowanceUsd: 5,
          monthlyLimitUsd: 5,
          now,
        })))),
    ]);

    expect([left.reserved, right.reserved].sort()).toEqual([false, true]);
    expect(classificationMonthlyCommittedUsd(first, now)).toBe(5);
    const admitted = left.reserved ? firstRun : secondRun;
    settleExplorationBudget(first, {
      explorationRunId: admitted,
      actualCostUsd: 0,
      settledAt: now.toISOString(),
    });
    expect(classificationMonthlyCommittedUsd(first, now)).toBe(0);
  });
});
