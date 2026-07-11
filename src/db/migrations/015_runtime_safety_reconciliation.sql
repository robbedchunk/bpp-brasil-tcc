-- One retailer/day network ceiling covers discovery and collection together.
-- The old per-stage trigger allowed 2,000 discovery requests plus another
-- 2,000 collection requests on the same day.
DROP TRIGGER request_admissions_daily_stage_cap;

CREATE TRIGGER request_admissions_daily_retailer_cap
BEFORE INSERT ON request_admissions
WHEN (
  SELECT COUNT(*)
  FROM request_admissions
  WHERE retailer_id = NEW.retailer_id
    AND collection_day = NEW.collection_day
) >= 2000
BEGIN
  SELECT RAISE(ABORT, 'daily retailer network request budget is exhausted');
END;

-- A synchronous classification provider call is durably reserved before the
-- request. A successor process can conservatively account for a request whose
-- response was lost to SIGKILL without silently releasing possible spend.
CREATE TABLE classification_sync_reservations (
  id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  product_ids_json TEXT NOT NULL CHECK (
    json_valid(product_ids_json)
    AND json_type(product_ids_json) = 'array'
    AND json_array_length(product_ids_json) > 0
  ),
  projected_cost_usd REAL NOT NULL CHECK (projected_cost_usd > 0),
  actual_cost_usd REAL CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'settled', 'recovered', 'released')
  ),
  month_start TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  settled_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (status = 'reserved' AND actual_cost_usd IS NULL AND settled_at IS NULL)
    OR (status <> 'reserved' AND actual_cost_usd IS NOT NULL AND settled_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX classification_sync_reservations_by_month_status
  ON classification_sync_reservations (month_start, status, reserved_at);

CREATE TRIGGER classification_sync_reservations_no_delete
BEFORE DELETE ON classification_sync_reservations
BEGIN
  SELECT RAISE(ABORT, 'synchronous classification reservations are append-only');
END;

CREATE TRIGGER classification_sync_reservations_lifecycle_only
BEFORE UPDATE ON classification_sync_reservations
WHEN OLD.status <> 'reserved'
  OR NEW.status NOT IN ('settled', 'recovered', 'released')
  OR NEW.id <> OLD.id
  OR NEW.request_sha256 <> OLD.request_sha256
  OR NEW.version <> OLD.version
  OR NEW.model <> OLD.model
  OR NEW.product_ids_json <> OLD.product_ids_json
  OR NEW.projected_cost_usd <> OLD.projected_cost_usd
  OR NEW.month_start <> OLD.month_start
  OR NEW.reserved_at <> OLD.reserved_at
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'synchronous classification reservation facts are immutable');
END;

ALTER TABLE cost_ledger
  ADD COLUMN classification_reservation_id TEXT
  REFERENCES classification_sync_reservations(id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX cost_ledger_by_classification_reservation
  ON cost_ledger (classification_reservation_id, occurred_at, id);

-- Append-only receipts explain every lifecycle repaired after exclusive-lock
-- recovery. They retain orphan admission IDs instead of laundering a crash
-- into an ordinary success/failure row.
CREATE TABLE runtime_reconciliations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('pipeline-run', 'exploration', 'classification-reservation')
  ),
  subject_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exploration_run_id TEXT
    REFERENCES exploration_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  classification_reservation_id TEXT
    REFERENCES classification_sync_reservations(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  reconciled_at TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (kind, subject_id),
  CHECK (
    (kind = 'pipeline-run' AND run_id = subject_id
      AND exploration_run_id IS NULL AND classification_reservation_id IS NULL)
    OR (kind = 'exploration' AND exploration_run_id = subject_id
      AND run_id IS NULL AND classification_reservation_id IS NULL)
    OR (kind = 'classification-reservation'
      AND classification_reservation_id = subject_id
      AND run_id IS NULL AND exploration_run_id IS NULL)
  )
) STRICT;

CREATE TRIGGER runtime_reconciliations_no_update
BEFORE UPDATE ON runtime_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'runtime reconciliation receipts are immutable');
END;

CREATE TRIGGER runtime_reconciliations_no_delete
BEFORE DELETE ON runtime_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'runtime reconciliation receipts are append-only');
END;
