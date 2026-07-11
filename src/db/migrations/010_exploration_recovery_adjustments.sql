CREATE TABLE exploration_recovery_adjustments (
  id TEXT PRIMARY KEY,
  exploration_run_id TEXT NOT NULL UNIQUE
    REFERENCES exploration_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  cost_ledger_id TEXT NOT NULL UNIQUE
    REFERENCES cost_ledger(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reserved_amount_usd REAL NOT NULL CHECK (reserved_amount_usd > 0),
  amount_usd REAL NOT NULL CHECK (
    amount_usd >= 0 AND amount_usd <= reserved_amount_usd
  ),
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
) STRICT;

CREATE TRIGGER exploration_recovery_adjustments_no_update
BEFORE UPDATE ON exploration_recovery_adjustments
BEGIN
  SELECT RAISE(ABORT, 'exploration recovery adjustments are immutable');
END;

CREATE TRIGGER exploration_recovery_adjustments_no_delete
BEFORE DELETE ON exploration_recovery_adjustments
BEGIN
  SELECT RAISE(ABORT, 'exploration recovery adjustments are append-only');
END;
