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
  it("rejects event allowances above USD 25 while permitting an operator monthly cap", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedRetailer(database);
    const now = new Date("2026-07-10T12:00:00.000Z");
    const explorationRunId = beginExplorationRun(database, {
      retailerId: "retailer-1",
      purpose: "extraction",
      trigger: "test",
      maxAttempts: 1,
      startedAt: now.toISOString(),
    });

    expect(() => reserveExplorationBudget(database, {
      explorationRunId,
      retailerId: "retailer-1",
      eventAllowanceUsd: 25.01,
      monthlyLimitUsd: 500,
      now,
    })).toThrow(/eventAllowanceUsd.*at most.*25/iu);
    expect(reserveExplorationBudget(database, {
      explorationRunId,
      retailerId: "retailer-1",
      eventAllowanceUsd: 25,
      monthlyLimitUsd: 500.01,
      now,
    })).toMatchObject({ reserved: true, amountUsd: 25 });
  });

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

  it("counts an active previous-month reservation against the new month", async () => {
    const directory = await mkdtemp(join(tmpdir(), "explorer-midnight-reservation-"));
    directories.push(directory);
    const path = join(directory, "evidence.sqlite");
    const beforeMidnight = openDatabase(path);
    const afterMidnight = openDatabase(path);
    databases.push(beforeMidnight, afterMidnight);
    seedRetailer(beforeMidnight, "before");
    seedRetailer(beforeMidnight, "after");
    const august = new Date("2026-08-31T23:59:59.000Z");
    const september = new Date("2026-09-01T00:00:01.000Z");
    const augustRun = beginExplorationRun(beforeMidnight, {
      retailerId: "before",
      purpose: "extraction",
      trigger: "test",
      maxAttempts: 1,
      startedAt: august.toISOString(),
    });
    const septemberRun = beginExplorationRun(beforeMidnight, {
      retailerId: "after",
      purpose: "extraction",
      trigger: "test",
      maxAttempts: 1,
      startedAt: september.toISOString(),
    });

    expect(reserveExplorationBudget(beforeMidnight, {
      explorationRunId: augustRun,
      retailerId: "before",
      eventAllowanceUsd: 5,
      monthlyLimitUsd: 5,
      now: august,
    }).reserved).toBe(true);
    expect(classificationMonthlyCommittedUsd(afterMidnight, september)).toBe(5);
    expect(reserveExplorationBudget(afterMidnight, {
      explorationRunId: septemberRun,
      retailerId: "after",
      eventAllowanceUsd: 5,
      monthlyLimitUsd: 5,
      now: september,
    }).reserved).toBe(false);
  });
});
