-- Discovery admits the broad food-at-home catalog, while the experimental
-- index can represent only the 84 official São Paulo IPCA subitems. A
-- high-confidence explicit null classification therefore records a second,
-- narrower scope decision instead of remaining forever in the index coverage
-- denominator.
CREATE TABLE classification_scope_decisions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL
    REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  classification_id TEXT NOT NULL UNIQUE
    REFERENCES classifications(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  classification_version INTEGER NOT NULL CHECK (classification_version > 0),
  action TEXT NOT NULL CHECK (action = 'excluded'),
  reason TEXT NOT NULL CHECK (reason = 'outside_ipca_measurement_frame'),
  rationale_code TEXT NOT NULL CHECK (length(trim(rationale_code)) > 0),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.8 AND 1),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (product_id, classification_version)
) STRICT;

CREATE INDEX classification_scope_decisions_by_product
  ON classification_scope_decisions (
    product_id,
    classification_version DESC,
    decided_at DESC,
    id DESC
  );

CREATE TRIGGER classification_scope_decisions_identity_guard
BEFORE INSERT ON classification_scope_decisions
WHEN NOT EXISTS (
  SELECT 1
  FROM classifications
  WHERE classifications.id = NEW.classification_id
    AND classifications.product_id = NEW.product_id
    AND classifications.version = NEW.classification_version
    AND classifications.ipca_item_id IS NULL
    AND classifications.confidence = NEW.confidence
    AND json_extract(classifications.output_json, '$.ipcaItemId') IS NULL
    AND json_extract(classifications.output_json, '$.rationaleCode') =
      NEW.rationale_code
)
BEGIN
  SELECT RAISE(ABORT, 'classification scope decision must bind its exact null classification');
END;

CREATE TRIGGER classification_scope_decisions_no_update
BEFORE UPDATE ON classification_scope_decisions
BEGIN
  SELECT RAISE(ABORT, 'classification scope decisions are immutable');
END;

CREATE TRIGGER classification_scope_decisions_no_delete
BEFORE DELETE ON classification_scope_decisions
BEGIN
  SELECT RAISE(ABORT, 'classification scope decisions are append-only');
END;
