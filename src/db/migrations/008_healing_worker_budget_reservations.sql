ALTER TABLE run_failures
  ADD COLUMN responded INTEGER CHECK (responded IS NULL OR responded IN (0, 1));

CREATE TABLE model_budget_reservations (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category = 'strategy-exploration'),
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exploration_run_id TEXT NOT NULL UNIQUE REFERENCES exploration_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount_usd REAL NOT NULL CHECK (amount_usd > 0),
  actual_cost_usd REAL NOT NULL DEFAULT 0 CHECK (actual_cost_usd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  month_start TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  settled_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (status = 'reserved' AND settled_at IS NULL)
    OR (status IN ('settled', 'released') AND settled_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX model_budget_reservations_by_month_status
  ON model_budget_reservations (month_start, status);

CREATE TRIGGER model_budget_reservations_no_delete
BEFORE DELETE ON model_budget_reservations
BEGIN
  SELECT RAISE(ABORT, 'model budget reservations are append-only');
END;

CREATE TRIGGER model_budget_reservations_lifecycle_only
BEFORE UPDATE ON model_budget_reservations
WHEN OLD.status <> 'reserved'
  OR NEW.status NOT IN ('settled', 'released')
  OR NEW.id <> OLD.id
  OR NEW.category <> OLD.category
  OR NEW.retailer_id <> OLD.retailer_id
  OR NEW.exploration_run_id <> OLD.exploration_run_id
  OR NEW.amount_usd <> OLD.amount_usd
  OR NEW.month_start <> OLD.month_start
  OR NEW.reserved_at <> OLD.reserved_at
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'model budget reservation facts are immutable');
END;
