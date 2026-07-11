import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";

import { finalizeRun } from "./repositories.js";

export interface RuntimeReconciliationSummary {
  pipelineRunIds: string[];
  explorationRunIds: string[];
}

function validTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new RangeError("runtime reconciliation timestamp is invalid");
  }
}

/**
 * Terminalizes runs left in `running` after the caller has acquired the
 * process-wide pipeline lock. Immutable admissions remain charged, and an
 * append-only receipt records request/reference/replay slots whose owning
 * process disappeared before normal finalization.
 */
export function reconcileInterruptedPipelineRuns(
  database: Database.Database,
  reconciledAt: string,
): string[] {
  validTimestamp(reconciledAt);
  return database.transaction((): string[] => {
    const runs = database.prepare(`
      SELECT id, retailer_id, stage, strategy_id, strategy_version
      FROM runs
      WHERE status = 'running' AND finished_at IS NULL
        AND stage IN ('discover', 'collect')
      ORDER BY started_at, id
    `).all() as Array<{
      id: string;
      retailer_id: string;
      stage: "discover" | "collect";
      strategy_id: string;
      strategy_version: number;
    }>;

    for (const run of runs) {
      const receiptId = randomUUID();
      const chargedRequestAdmissionIds = (database.prepare(`
        SELECT id FROM request_admissions WHERE run_id = ?
        ORDER BY admitted_at, id
      `).all(run.id) as Array<{ id: string }>).map(({ id }) => id);
      const orphanReplaySlotIds = (database.prepare(`
        SELECT slot.id
        FROM replay_slot_admissions AS slot
        WHERE slot.run_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM observations
            WHERE observations.run_id = slot.run_id
              AND observations.product_id = slot.product_id
              AND observations.response_path IS NOT NULL
            UNION ALL
            SELECT 1 FROM run_failures
            WHERE run_failures.run_id = slot.run_id
              AND run_failures.product_id = slot.product_id
              AND run_failures.response_path IS NOT NULL
          )
        ORDER BY slot.admitted_at, slot.id
      `).all(run.id) as Array<{ id: string }>).map(({ id }) => id);
      const orphanDiscoveryReferenceIds = run.stage === "discover"
        ? (database.prepare(`
            SELECT admission.id
            FROM discovery_reference_admissions AS admission
            WHERE admission.run_id = ?
              AND NOT EXISTS (
                SELECT 1
                FROM products
                JOIN product_scope_decisions AS decision
                  ON decision.product_id = products.id
                WHERE decision.run_id = admission.run_id
                  AND products.retailer_id = admission.retailer_id
                  AND products.canonical_url = admission.canonical_url
              )
            ORDER BY admission.admitted_at, admission.id
          `).all(run.id) as Array<{ id: string }>).map(({ id }) => id)
        : [];
      const details = {
        reason: "exclusive-lock-recovered-interrupted-pipeline-run",
        previousStatus: "running",
        chargedRequestAdmissionIds,
        orphanDiscoveryReferenceIds,
        orphanReplaySlotIds,
      };
      database.prepare(`
        INSERT INTO runtime_reconciliations
          (id, kind, subject_id, run_id, reconciled_at, details_json)
        VALUES (?, 'pipeline-run', ?, ?, ?, ?)
      `).run(receiptId, run.id, run.id, reconciledAt, JSON.stringify(details));
      database.prepare(`
        INSERT INTO run_failures
          (id, run_id, retailer_id, category, message, responded,
           strategy_id, strategy_version, occurred_at)
        VALUES (?, ?, ?, 'unknown', ?, 0, ?, ?, ?)
      `).run(
        randomUUID(),
        run.id,
        run.retailer_id,
        `Interrupted process recovered under exclusive lock; receipt ${receiptId}`,
        run.strategy_id,
        run.strategy_version,
        reconciledAt,
      );

      let ok: number;
      if (run.stage === "collect") {
        ok = (database.prepare(
          "SELECT COUNT(*) AS count FROM observations WHERE run_id = ?",
        ).get(run.id) as { count: number }).count;
      } else {
        const scope = database.prepare(`
          SELECT COUNT(*) AS discovered,
                 COALESCE(SUM(in_scope), 0) AS inScope
          FROM product_scope_decisions WHERE run_id = ?
        `).get(run.id) as { discovered: number; inScope: number };
        ok = scope.discovered;
        database.prepare(`
          INSERT INTO catalog_snapshots
            (run_id, retailer_id, complete, completion_reason, discovered,
             in_scope, out_of_scope, disappeared, completed_at)
          VALUES (?, ?, 0, 'interrupted_process_reconciliation', ?, ?, ?, 0, ?)
        `).run(
          run.id,
          run.retailer_id,
          scope.discovered,
          scope.inScope,
          scope.discovered - scope.inScope,
          reconciledAt,
        );
      }
      const failed = (database.prepare(
        "SELECT COUNT(*) AS count FROM run_failures WHERE run_id = ?",
      ).get(run.id) as { count: number }).count;
      finalizeRun(
        database,
        run.id,
        { attempted: ok + failed, ok, failed },
        ok > 0 ? "partial" : "failed",
        reconciledAt,
        {
          category: "unknown",
          message: `Interrupted process recovered under exclusive lock; receipt ${receiptId}`,
        },
      );
    }
    return runs.map(({ id }) => id);
  }).immediate();
}

/**
 * Reconciles non-healing exploration work after acquiring the explorer lock.
 * A running paid reservation is conservatively charged in full; a run that
 * had already finished before settlement uses its complete immutable ledger.
 */
export function reconcileInterruptedStandaloneExplorations(
  database: Database.Database,
  reconciledAt: string,
): string[] {
  validTimestamp(reconciledAt);
  return database.transaction((): string[] => {
    const rows = database.prepare(`
      SELECT run.id, run.retailer_id, run.status, run.events_used,
             run.input_tokens, run.output_tokens, run.cost_usd,
             reservation.amount_usd, reservation.actual_cost_usd,
             reservation.status AS reservation_status
      FROM exploration_runs AS run
      LEFT JOIN model_budget_reservations AS reservation
        ON reservation.exploration_run_id = run.id
      WHERE run.healing_event_id IS NULL
        AND (run.status = 'running' OR reservation.status = 'reserved')
      ORDER BY run.started_at, run.id
    `).all() as Array<{
      id: string;
      retailer_id: string;
      status: string;
      events_used: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      amount_usd: number | null;
      actual_cost_usd: number | null;
      reservation_status: string | null;
    }>;

    for (const run of rows) {
      const attempts = database.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS inputTokens,
               COALESCE(SUM(output_tokens), 0) AS outputTokens,
               COALESCE(SUM(cost_usd), 0) AS costUsd
        FROM exploration_attempts WHERE exploration_run_id = ?
      `).get(run.id) as {
        count: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
      };
      const ledgerBefore = database.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) AS costUsd,
               COALESCE(SUM(input_tokens), 0) AS inputTokens,
               COALESCE(SUM(output_tokens), 0) AS outputTokens
        FROM cost_ledger WHERE exploration_run_id = ?
      `).get(run.id) as { costUsd: number; inputTokens: number; outputTokens: number };
      const attemptCost = new Decimal(attempts.costUsd).toDecimalPlaces(12);
      if (
        run.events_used !== attempts.count
        || run.input_tokens !== attempts.inputTokens
        || run.output_tokens !== attempts.outputTokens
        || ledgerBefore.inputTokens !== attempts.inputTokens
        || ledgerBefore.outputTokens !== attempts.outputTokens
        || !new Decimal(run.cost_usd).toDecimalPlaces(12).equals(attemptCost)
        || !new Decimal(ledgerBefore.costUsd).toDecimalPlaces(12).equals(attemptCost)
      ) {
        throw new Error(`Standalone exploration ${run.id} evidence is inconsistent`);
      }
      if (run.reservation_status === null && !attemptCost.isZero()) {
        throw new Error(`Paid standalone exploration ${run.id} has no budget reservation`);
      }
      if (
        run.reservation_status !== null
        && run.reservation_status !== "reserved"
        && (
          run.actual_cost_usd === null
          || !new Decimal(run.actual_cost_usd).toDecimalPlaces(12).equals(attemptCost)
        )
      ) {
        throw new Error(`Standalone exploration ${run.id} settlement disagrees with evidence`);
      }

      let finalCost = attemptCost;
      let recoveryAdjustment = new Decimal(0);
      let recoveryLedgerId: string | null = null;
      if (run.status === "running" && run.reservation_status === "reserved") {
        if (run.amount_usd === null) throw new Error("Active exploration reservation has no amount");
        recoveryAdjustment = Decimal.max(
          new Decimal(run.amount_usd).minus(attemptCost),
          0,
        ).toDecimalPlaces(12);
        finalCost = attemptCost.plus(recoveryAdjustment).toDecimalPlaces(12);
        const adjustmentId = randomUUID();
        recoveryLedgerId = randomUUID();
        const recoveryDetails = {
          recoveryAdjustmentId: adjustmentId,
          reason: "interrupted-standalone-exploration",
          reservedAmountUsd: run.amount_usd,
          attemptCostUsd: attemptCost.toNumber(),
          unaccountedRemainderUsd: recoveryAdjustment.toNumber(),
        };
        database.prepare(`
          INSERT INTO cost_ledger
            (id, category, retailer_id, exploration_run_id, provider, model,
             input_tokens, output_tokens, cost_usd, occurred_at, details_json)
          VALUES (?, 'strategy-exploration-recovery', ?, ?,
                  'internal-recovery', NULL, 0, 0, ?, ?, ?)
        `).run(
          recoveryLedgerId,
          run.retailer_id,
          run.id,
          recoveryAdjustment.toNumber(),
          reconciledAt,
          JSON.stringify(recoveryDetails),
        );
        database.prepare(`
          INSERT INTO exploration_recovery_adjustments
            (id, exploration_run_id, cost_ledger_id, reserved_amount_usd,
             amount_usd, created_at, details_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          adjustmentId,
          run.id,
          recoveryLedgerId,
          run.amount_usd,
          recoveryAdjustment.toNumber(),
          reconciledAt,
          JSON.stringify(recoveryDetails),
        );
        database.prepare(
          "UPDATE exploration_runs SET cost_usd = ? WHERE id = ? AND status = 'running'",
        ).run(finalCost.toNumber(), run.id);
      }

      if (run.status === "running") {
        const finished = database.prepare(`
          UPDATE exploration_runs
          SET status = 'finished', outcome = 'interrupted_reconciled',
              artifact_json = ?, error_message = ?, finished_at = ?
          WHERE id = ? AND status = 'running' AND finished_at IS NULL
        `).run(
          JSON.stringify({
            reconciled: true,
            evidenceSource: "exclusive-lock-immutable-ledgers",
            attemptCostUsd: attemptCost.toNumber(),
            recoveryAdjustmentUsd: recoveryAdjustment.toNumber(),
          }),
          "Standalone exploration process ended before terminal commit",
          reconciledAt,
          run.id,
        );
        if (finished.changes !== 1) throw new Error(`Exploration ${run.id} changed during recovery`);
      }

      if (run.reservation_status === "reserved") {
        const settled = database.prepare(`
          UPDATE model_budget_reservations
          SET status = ?, actual_cost_usd = ?, settled_at = ?,
              details_json = json_set(
                details_json, '$.actualCostUsd', ?, '$.reconciled', json('true')
              )
          WHERE exploration_run_id = ? AND status = 'reserved'
        `).run(
          finalCost.isZero() ? "released" : "settled",
          finalCost.toNumber(),
          reconciledAt,
          finalCost.toNumber(),
          run.id,
        );
        if (settled.changes !== 1) throw new Error(`Exploration ${run.id} reservation changed`);
      }

      const details = {
        reason: "exclusive-lock-recovered-standalone-exploration",
        previousStatus: run.status,
        attempts: attempts.count,
        attemptCostUsd: attemptCost.toNumber(),
        recoveryAdjustmentUsd: recoveryAdjustment.toNumber(),
        finalCostUsd: finalCost.toNumber(),
        recoveryLedgerId,
      };
      database.prepare(`
        INSERT INTO runtime_reconciliations
          (id, kind, subject_id, exploration_run_id, reconciled_at, details_json)
        VALUES (?, 'exploration', ?, ?, ?, ?)
      `).run(randomUUID(), run.id, run.id, reconciledAt, JSON.stringify(details));
    }
    return rows.map(({ id }) => id);
  }).immediate();
}
