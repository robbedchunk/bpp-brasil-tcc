ALTER TABLE products ADD COLUMN last_observed_at TEXT;
ALTER TABLE products ADD COLUMN last_collection_attempt_at TEXT;
ALTER TABLE products ADD COLUMN descriptive_title INTEGER NOT NULL DEFAULT 0
  CHECK (descriptive_title IN (0, 1));

UPDATE products
SET last_observed_at = (
      SELECT MAX(observed_at)
      FROM observations
      WHERE observations.product_id = products.id
    ),
    last_collection_attempt_at = (
      SELECT MAX(attempted_at)
      FROM (
        SELECT observed_at AS attempted_at
        FROM observations
        WHERE observations.product_id = products.id
        UNION ALL
        SELECT occurred_at AS attempted_at
        FROM run_failures
        WHERE run_failures.product_id = products.id
      )
    ),
    descriptive_title = CASE
      WHEN EXISTS (
        SELECT 1 FROM observations WHERE observations.product_id = products.id
      )
      AND length(trim(title)) >= 2
      AND lower(trim(title)) <> 'produto aguardando observação descritiva'
      AND trim(title) GLOB '*[A-Za-zÀ-ÿ]*' THEN 1
      ELSE 0
    END;

CREATE INDEX products_by_collection_rotation
  ON products (
    retailer_id,
    active,
    in_scope,
    last_collection_attempt_at,
    last_observed_at,
    id
  );

-- A request is charged before network execution and remains charged even when
-- the process crashes before its run can be finalized. The stage ordinal is
-- assigned inside BEGIN IMMEDIATE, making the count-and-insert admission gate
-- safe across concurrent SQLite connections.
CREATE TABLE request_admissions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL
    REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  retailer_id TEXT NOT NULL
    REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  collection_day TEXT NOT NULL CHECK (
    length(collection_day) = 10
    AND date(collection_day) = collection_day
  ),
  stage TEXT NOT NULL CHECK (stage IN ('discover', 'collect')),
  stage_ordinal INTEGER NOT NULL CHECK (stage_ordinal >= 1),
  admitted_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) IS NOT NULL
    AND admitted_at = strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at)
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (retailer_id, collection_day, stage, stage_ordinal)
) STRICT;

CREATE INDEX request_admissions_by_run
  ON request_admissions (run_id, stage_ordinal);

CREATE TRIGGER request_admissions_run_identity_guard
BEFORE INSERT ON request_admissions
WHEN NOT EXISTS (
  SELECT 1
  FROM runs
  WHERE runs.id = NEW.run_id
    AND runs.retailer_id = NEW.retailer_id
    AND runs.collection_day = NEW.collection_day
    AND runs.stage = NEW.stage
    AND runs.status = 'running'
    AND runs.finished_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'request admission identity must match its run');
END;

CREATE TRIGGER request_admissions_daily_stage_cap
BEFORE INSERT ON request_admissions
WHEN (
  SELECT COUNT(*)
  FROM request_admissions
  WHERE retailer_id = NEW.retailer_id
    AND collection_day = NEW.collection_day
    AND stage = NEW.stage
) >= 2000
BEGIN
  SELECT RAISE(ABORT, 'daily stage request budget is exhausted');
END;

CREATE TRIGGER request_admissions_no_update
BEFORE UPDATE ON request_admissions
BEGIN
  SELECT RAISE(ABORT, 'request admissions are immutable');
END;

CREATE TRIGGER request_admissions_no_delete
BEFORE DELETE ON request_admissions
BEGIN
  SELECT RAISE(ABORT, 'request admissions are append-only');
END;

-- Discovery references have a separate 3,000/day catalog-output budget. Like
-- request admissions, a reference remains charged if the process dies before
-- product persistence or run finalization.
CREATE TABLE discovery_reference_admissions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL
    REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  retailer_id TEXT NOT NULL
    REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  collection_day TEXT NOT NULL CHECK (
    length(collection_day) = 10
    AND date(collection_day) = collection_day
  ),
  day_ordinal INTEGER NOT NULL CHECK (day_ordinal >= 1),
  canonical_url TEXT,
  admitted_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) IS NOT NULL
    AND admitted_at = strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at)
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (retailer_id, collection_day, day_ordinal)
) STRICT;

CREATE INDEX discovery_reference_admissions_by_run
  ON discovery_reference_admissions (run_id, day_ordinal);

CREATE TRIGGER discovery_reference_admissions_identity_guard
BEFORE INSERT ON discovery_reference_admissions
WHEN NOT EXISTS (
  SELECT 1 FROM runs
  WHERE runs.id = NEW.run_id
    AND runs.retailer_id = NEW.retailer_id
    AND runs.collection_day = NEW.collection_day
    AND runs.stage = 'discover'
    AND runs.status = 'running'
    AND runs.finished_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'discovery reference admission must match its run');
END;

CREATE TRIGGER discovery_reference_admissions_daily_cap
BEFORE INSERT ON discovery_reference_admissions
WHEN (
  SELECT COUNT(*) FROM discovery_reference_admissions
  WHERE retailer_id = NEW.retailer_id
    AND collection_day = NEW.collection_day
) >= 3000
BEGIN
  SELECT RAISE(ABORT, 'daily discovery reference budget is exhausted');
END;

CREATE TRIGGER discovery_reference_admissions_no_update
BEFORE UPDATE ON discovery_reference_admissions
BEGIN
  SELECT RAISE(ABORT, 'discovery reference admissions are immutable');
END;

CREATE TRIGGER discovery_reference_admissions_no_delete
BEFORE DELETE ON discovery_reference_admissions
BEGIN
  SELECT RAISE(ABORT, 'discovery reference admissions are append-only');
END;

-- Replay selection retains reservoir sampling, while these slots provide the
-- durable cross-run hard gate. A slot is charged immediately before file I/O.
CREATE TABLE replay_slot_admissions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL
    REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  retailer_id TEXT NOT NULL
    REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_id TEXT NOT NULL
    REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  collection_day TEXT NOT NULL CHECK (
    length(collection_day) = 10
    AND date(collection_day) = collection_day
  ),
  day_ordinal INTEGER NOT NULL CHECK (day_ordinal >= 1),
  admitted_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) IS NOT NULL
    AND admitted_at = strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at)
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (retailer_id, collection_day, day_ordinal)
) STRICT;

CREATE INDEX replay_slot_admissions_by_run
  ON replay_slot_admissions (run_id, day_ordinal);

CREATE TRIGGER replay_slot_admissions_identity_guard
BEFORE INSERT ON replay_slot_admissions
WHEN NOT EXISTS (
  SELECT 1
  FROM runs
  JOIN products ON products.id = NEW.product_id
  WHERE runs.id = NEW.run_id
    AND runs.retailer_id = NEW.retailer_id
    AND runs.collection_day = NEW.collection_day
    AND runs.stage = 'collect'
    AND runs.status = 'running'
    AND runs.finished_at IS NULL
    AND products.retailer_id = NEW.retailer_id
)
BEGIN
  SELECT RAISE(ABORT, 'replay slot admission must match its run and product');
END;

CREATE TRIGGER replay_slot_admissions_daily_cap
BEFORE INSERT ON replay_slot_admissions
WHEN (
  SELECT COUNT(*) FROM replay_slot_admissions
  WHERE retailer_id = NEW.retailer_id
    AND collection_day = NEW.collection_day
) >= 20
BEGIN
  SELECT RAISE(ABORT, 'daily replay slot budget is exhausted');
END;

CREATE TRIGGER replay_slot_admissions_no_update
BEFORE UPDATE ON replay_slot_admissions
BEGIN
  SELECT RAISE(ABORT, 'replay slot admissions are immutable');
END;

CREATE TRIGGER replay_slot_admissions_no_delete
BEFORE DELETE ON replay_slot_admissions
BEGIN
  SELECT RAISE(ABORT, 'replay slot admissions are append-only');
END;

-- Offline normalization-bug re-extractions persist only structured results
-- and the verified logical replay reference; the raw response body stays in
-- the ignored private replay root.
CREATE TABLE replay_reextractions (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL
    REFERENCES observations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  retailer_id TEXT NOT NULL
    REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_id TEXT NOT NULL
    REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  strategy_id TEXT NOT NULL
    REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  strategy_version INTEGER NOT NULL CHECK (strategy_version > 0),
  response_path TEXT NOT NULL,
  response_sha256 TEXT NOT NULL CHECK (
    length(response_sha256) = 64
    AND response_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json)
    AND json_type(result_json, '$.ok') IN ('true', 'false')
    AND json_type(result_json, '$.replay') IS NULL
  ),
  executed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', executed_at) IS NOT NULL
    AND executed_at = strftime('%Y-%m-%dT%H:%M:%fZ', executed_at)
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX replay_reextractions_by_observation_time
  ON replay_reextractions (observation_id, executed_at DESC);

CREATE TRIGGER replay_reextractions_identity_guard
BEFORE INSERT ON replay_reextractions
WHEN NOT EXISTS (
  SELECT 1
  FROM observations
  JOIN products ON products.id = observations.product_id
  WHERE observations.id = NEW.observation_id
    AND observations.product_id = NEW.product_id
    AND products.retailer_id = NEW.retailer_id
    AND observations.strategy_id = NEW.strategy_id
    AND observations.strategy_version = NEW.strategy_version
    AND observations.response_path = NEW.response_path
    AND observations.response_sha256 = NEW.response_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'replay re-extraction must match its source observation');
END;

CREATE TRIGGER replay_reextractions_no_update
BEFORE UPDATE ON replay_reextractions
BEGIN
  SELECT RAISE(ABORT, 'replay re-extractions are immutable');
END;

CREATE TRIGGER replay_reextractions_no_delete
BEFORE DELETE ON replay_reextractions
BEGIN
  SELECT RAISE(ABORT, 'replay re-extractions are append-only');
END;

CREATE TABLE product_scope_decisions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL
    REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  run_id TEXT NOT NULL
    REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  in_scope INTEGER NOT NULL CHECK (in_scope IN (0, 1)),
  source_category TEXT,
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  rule_version TEXT NOT NULL CHECK (length(rule_version) > 0),
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (run_id, product_id)
) STRICT;

CREATE INDEX product_scope_decisions_by_product_time
  ON product_scope_decisions (product_id, decided_at DESC, id DESC);

CREATE TABLE catalog_snapshots (
  run_id TEXT PRIMARY KEY
    REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  retailer_id TEXT NOT NULL
    REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  completion_reason TEXT NOT NULL CHECK (length(completion_reason) > 0),
  discovered INTEGER NOT NULL CHECK (discovered >= 0),
  in_scope INTEGER NOT NULL CHECK (in_scope >= 0),
  out_of_scope INTEGER NOT NULL CHECK (out_of_scope >= 0),
  disappeared INTEGER NOT NULL CHECK (disappeared >= 0),
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (discovered = in_scope + out_of_scope),
  CHECK (complete = 1 OR disappeared = 0)
) STRICT;

CREATE INDEX catalog_snapshots_by_retailer_time
  ON catalog_snapshots (retailer_id, completed_at DESC);

CREATE TRIGGER product_scope_decisions_no_update
BEFORE UPDATE ON product_scope_decisions
BEGIN
  SELECT RAISE(ABORT, 'product scope decisions are immutable');
END;

CREATE TRIGGER product_scope_decisions_identity_guard
BEFORE INSERT ON product_scope_decisions
WHEN NOT EXISTS (
  SELECT 1
  FROM runs
  JOIN products ON products.id = NEW.product_id
  WHERE runs.id = NEW.run_id
    AND runs.stage = 'discover'
    AND runs.status = 'running'
    AND runs.finished_at IS NULL
    AND runs.retailer_id = products.retailer_id
)
BEGIN
  SELECT RAISE(ABORT, 'product scope decision must match a running discovery run');
END;

CREATE TRIGGER product_scope_decisions_no_delete
BEFORE DELETE ON product_scope_decisions
BEGIN
  SELECT RAISE(ABORT, 'product scope decisions are append-only');
END;

CREATE TRIGGER catalog_snapshots_no_update
BEFORE UPDATE ON catalog_snapshots
BEGIN
  SELECT RAISE(ABORT, 'catalog snapshots are immutable');
END;

CREATE TRIGGER catalog_snapshots_identity_guard
BEFORE INSERT ON catalog_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM runs
  WHERE runs.id = NEW.run_id
    AND runs.stage = 'discover'
    AND runs.status = 'running'
    AND runs.finished_at IS NULL
    AND runs.retailer_id = NEW.retailer_id
)
BEGIN
  SELECT RAISE(ABORT, 'catalog snapshot must match a running discovery run');
END;

CREATE TRIGGER catalog_snapshots_no_delete
BEFORE DELETE ON catalog_snapshots
BEGIN
  SELECT RAISE(ABORT, 'catalog snapshots are append-only');
END;

CREATE TRIGGER observations_replay_reference_guard
BEFORE INSERT ON observations
WHEN
  (NEW.response_path IS NULL) <> (NEW.response_sha256 IS NULL)
  OR (
    NEW.response_sha256 IS NOT NULL
    AND (
      length(NEW.response_sha256) <> 64
      OR NEW.response_sha256 GLOB '*[^0-9a-f]*'
      OR NEW.response_path LIKE '/%'
      OR NEW.response_path LIKE '%..%'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'observation replay reference is invalid');
END;

CREATE TRIGGER observations_run_identity_guard
BEFORE INSERT ON observations
WHEN NOT EXISTS (
  SELECT 1
  FROM runs
  JOIN products ON products.id = NEW.product_id
  WHERE runs.id = NEW.run_id
    AND runs.stage = 'collect'
    AND runs.status = 'running'
    AND runs.finished_at IS NULL
    AND runs.retailer_id = products.retailer_id
    AND runs.collection_day = NEW.collection_day
    AND runs.strategy_id = NEW.strategy_id
    AND runs.strategy_version = NEW.strategy_version
)
BEGIN
  SELECT RAISE(ABORT, 'observation must match a running collection run');
END;

CREATE TRIGGER run_failures_replay_reference_guard
BEFORE INSERT ON run_failures
WHEN
  (NEW.response_path IS NULL) <> (NEW.response_sha256 IS NULL)
  OR (
    NEW.response_sha256 IS NOT NULL
    AND (
      length(NEW.response_sha256) <> 64
      OR NEW.response_sha256 GLOB '*[^0-9a-f]*'
      OR NEW.response_path LIKE '/%'
      OR NEW.response_path LIKE '%..%'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'failure replay reference is invalid');
END;

CREATE TRIGGER run_failures_run_identity_guard
BEFORE INSERT ON run_failures
WHEN NOT EXISTS (
  SELECT 1
  FROM runs
  WHERE runs.id = NEW.run_id
    AND runs.status = 'running'
    AND runs.finished_at IS NULL
    AND runs.retailer_id = NEW.retailer_id
    AND runs.strategy_id = NEW.strategy_id
    AND runs.strategy_version = NEW.strategy_version
    AND (
      NEW.product_id IS NULL
      OR EXISTS (
        SELECT 1 FROM products
        WHERE products.id = NEW.product_id
          AND products.retailer_id = runs.retailer_id
          AND runs.stage = 'collect'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'run failure must match its running run');
END;
