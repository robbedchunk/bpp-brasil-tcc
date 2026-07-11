import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import {
  admitReplaySlot,
  admitRequest,
  beginExplorationRun,
  createRun,
} from "../../src/db/repositories.js";
import {
  reconcileInterruptedPipelineRuns,
  reconcileInterruptedStandaloneExplorations,
} from "../../src/db/runtime-reconciliation.js";
import {
  BudgetGuard,
  classificationMonthlyCommittedUsd,
  reconcileSynchronousClassificationReservations,
  reserveExplorationBudget,
  reserveSynchronousClassificationBudget,
} from "../../src/ops/budget.js";
import {
  extractionStrategy,
  seedRetailer,
  seedStrategy,
} from "../pipeline/helpers.js";

const RECONCILED_AT = "2026-07-10T13:00:00.000Z";

describe("exclusive-lock runtime reconciliation", () => {
  it("terminalizes a SIGKILL-stranded pipeline run and binds orphan slots", () => {
    const database = openDatabase(":memory:");
    try {
      seedRetailer(database);
      seedStrategy(database, "extraction", extractionStrategy);
      database.prepare(`
        INSERT INTO products
          (id, retailer_id, canonical_url, title, first_seen, last_seen)
        VALUES ('p1', 'retailer-1', 'https://shop.test/p1', 'Arroz tipo 1',
                '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
      `).run();
      createRun(database, {
        id: "killed-run",
        retailerId: "retailer-1",
        stage: "collect",
        collectionDay: "2026-07-10",
        strategyId: "retailer-1-extraction-v1",
        strategyVersion: 1,
        startedAt: "2026-07-10T12:00:00.000Z",
      });
      admitRequest(database, {
        runId: "killed-run",
        retailerId: "retailer-1",
        collectionDay: "2026-07-10",
        stage: "collect",
        admittedAt: "2026-07-10T12:00:01.000Z",
        id: "charged-request",
      });
      admitReplaySlot(database, {
        runId: "killed-run",
        retailerId: "retailer-1",
        productId: "p1",
        collectionDay: "2026-07-10",
        admittedAt: "2026-07-10T12:00:02.000Z",
        id: "orphan-replay-slot",
      });

      expect(reconcileInterruptedPipelineRuns(database, RECONCILED_AT))
        .toEqual(["killed-run"]);
      expect(database.prepare(`
        SELECT status, attempted, ok, failed, finished_at AS finishedAt,
               error_category AS errorCategory
        FROM runs WHERE id = 'killed-run'
      `).get()).toEqual({
        status: "failed",
        attempted: 1,
        ok: 0,
        failed: 1,
        finishedAt: RECONCILED_AT,
        errorCategory: "unknown",
      });
      const receipt = database.prepare(`
        SELECT details_json AS detailsJson
        FROM runtime_reconciliations
        WHERE kind = 'pipeline-run' AND subject_id = 'killed-run'
      `).get() as { detailsJson: string };
      expect(JSON.parse(receipt.detailsJson)).toMatchObject({
        chargedRequestAdmissionIds: ["charged-request"],
        orphanReplaySlotIds: ["orphan-replay-slot"],
      });
      expect(() => admitRequest(database, {
        runId: "killed-run",
        retailerId: "retailer-1",
        collectionDay: "2026-07-10",
        stage: "collect",
        admittedAt: "2026-07-10T13:00:01.000Z",
      })).toThrow(/existing run/iu);
      expect(reconcileInterruptedPipelineRuns(database, RECONCILED_AT)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("charges an interrupted standalone exploration reservation conservatively", () => {
    const database = openDatabase(":memory:");
    try {
      seedRetailer(database);
      const explorationRunId = beginExplorationRun(database, {
        retailerId: "retailer-1",
        purpose: "extraction",
        trigger: "manual",
        maxAttempts: 3,
        startedAt: "2026-07-10T12:00:00.000Z",
      });
      expect(reserveExplorationBudget(database, {
        explorationRunId,
        retailerId: "retailer-1",
        eventAllowanceUsd: 5,
        monthlyLimitUsd: 50,
        now: new Date("2026-07-10T12:00:01.000Z"),
      }).reserved).toBe(true);

      expect(reconcileInterruptedStandaloneExplorations(database, RECONCILED_AT))
        .toEqual([explorationRunId]);
      expect(database.prepare(`
        SELECT status, outcome, cost_usd AS costUsd, finished_at AS finishedAt
        FROM exploration_runs WHERE id = ?
      `).get(explorationRunId)).toEqual({
        status: "finished",
        outcome: "interrupted_reconciled",
        costUsd: 5,
        finishedAt: RECONCILED_AT,
      });
      expect(database.prepare(`
        SELECT status, actual_cost_usd AS actualCostUsd
        FROM model_budget_reservations WHERE exploration_run_id = ?
      `).get(explorationRunId)).toEqual({ status: "settled", actualCostUsd: 5 });
      expect(database.prepare(`
        SELECT amount_usd AS amountUsd
        FROM exploration_recovery_adjustments WHERE exploration_run_id = ?
      `).get(explorationRunId)).toEqual({ amountUsd: 5 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM runtime_reconciliations
        WHERE kind = 'exploration' AND subject_id = ?
      `).get(explorationRunId)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("recovers a pre-request synchronous classification reservation", () => {
    const database = openDatabase(":memory:");
    try {
      const reservation = reserveSynchronousClassificationBudget(database, {
        version: 1,
        model: "gpt-5.6-luna",
        productIds: ["p1", "p2"],
        projectedCostUsd: 0.5,
        now: new Date("2026-07-10T12:00:00.000Z"),
        budgetGuard: new BudgetGuard(50),
      });
      expect(reservation.reserved).toBe(true);
      expect(reservation.reservationId).not.toBeNull();

      expect(reconcileSynchronousClassificationReservations(database, RECONCILED_AT))
        .toEqual([reservation.reservationId]);
      expect(database.prepare(`
        SELECT status, actual_cost_usd AS actualCostUsd
        FROM classification_sync_reservations WHERE id = ?
      `).get(reservation.reservationId)).toEqual({
        status: "recovered",
        actualCostUsd: 0.5,
      });
      expect(database.prepare(`
        SELECT category, cost_usd AS costUsd, classification_reservation_id AS reservationId
        FROM cost_ledger
      `).get()).toEqual({
        category: "classification-recovery",
        costUsd: 0.5,
        reservationId: reservation.reservationId,
      });
      expect(classificationMonthlyCommittedUsd(
        database,
        new Date("2026-07-10T14:00:00.000Z"),
      )).toBe(0.5);
      expect(reconcileSynchronousClassificationReservations(database, RECONCILED_AT))
        .toEqual([]);
    } finally {
      database.close();
    }
  });
});
