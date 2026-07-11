CREATE TABLE strategy_validation_evidence (
  strategy_id TEXT PRIMARY KEY
    REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  receipt_path TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  sample_set_sha256 TEXT NOT NULL CHECK (
    length(sample_set_sha256) = 64 AND sample_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  executor_json TEXT NOT NULL CHECK (json_valid(executor_json)),
  attestation_key_id TEXT NOT NULL CHECK (
    length(attestation_key_id) = 64 AND attestation_key_id NOT GLOB '*[^0-9a-f]*'
  ),
  attempted INTEGER NOT NULL CHECK (attempted = 30),
  valid INTEGER NOT NULL CHECK (valid BETWEEN 0 AND attempted),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  validated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', validated_at) IS NOT NULL
  ),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER strategy_validation_evidence_no_update
BEFORE UPDATE ON strategy_validation_evidence
BEGIN
  SELECT RAISE(ABORT, 'strategy validation evidence is immutable');
END;

CREATE TRIGGER strategy_validation_evidence_no_delete
BEFORE DELETE ON strategy_validation_evidence
BEGIN
  SELECT RAISE(ABORT, 'strategy validation evidence is append-only');
END;

CREATE TRIGGER strategies_active_insert_requires_validation_evidence
BEFORE INSERT ON strategies
WHEN NEW.active = 1
BEGIN
  SELECT RAISE(ABORT, 'strategies must be inserted inactive before evidence-backed activation');
END;

CREATE TRIGGER strategies_activation_requires_validation_evidence
BEFORE UPDATE OF active ON strategies
WHEN NEW.active = 1 AND OLD.active = 0
  AND NOT EXISTS (
    SELECT 1 FROM strategy_validation_evidence
    WHERE strategy_id = NEW.id
      AND attempted = 30
      AND valid >= 27
      AND score >= 0.9
  )
BEGIN
  SELECT RAISE(ABORT, 'strategy activation requires immutable validation evidence');
END;
