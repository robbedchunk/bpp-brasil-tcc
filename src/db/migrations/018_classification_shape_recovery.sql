-- A synchronous classification response that violates the
-- exactly-one-result-per-input invariant is recorded as an append-only fact
-- per product. The next run shrinks the failing request instead of
-- resubmitting an identical batch forever.
CREATE TABLE classification_shape_failures (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  batch_size INTEGER NOT NULL CHECK (batch_size > 0),
  failure_kind TEXT NOT NULL CHECK (length(trim(failure_kind)) > 0),
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX classification_shape_failures_by_product
  ON classification_shape_failures (version, product_id, occurred_at);

CREATE TRIGGER classification_shape_failures_no_update
BEFORE UPDATE ON classification_shape_failures
BEGIN
  SELECT RAISE(ABORT, 'classification shape failures are immutable');
END;

CREATE TRIGGER classification_shape_failures_no_delete
BEFORE DELETE ON classification_shape_failures
BEGIN
  SELECT RAISE(ABORT, 'classification shape failures are append-only');
END;

-- Products whose requests keep failing the shape invariant are quarantined
-- instead of being retried nightly. Quarantine is an append-only event
-- stream: the latest action per (product, version) is authoritative, and an
-- operator release row makes the product eligible again without deleting any
-- evidence.
CREATE TABLE classification_quarantine_events (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  action TEXT NOT NULL CHECK (action IN ('quarantined', 'released')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX classification_quarantine_events_by_product
  ON classification_quarantine_events (version, product_id, occurred_at, id);

CREATE TRIGGER classification_quarantine_events_no_update
BEFORE UPDATE ON classification_quarantine_events
BEGIN
  SELECT RAISE(ABORT, 'classification quarantine events are immutable');
END;

CREATE TRIGGER classification_quarantine_events_no_delete
BEFORE DELETE ON classification_quarantine_events
BEGIN
  SELECT RAISE(ABORT, 'classification quarantine events are append-only');
END;
