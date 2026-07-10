ALTER TABLE ipca_items
  ADD COLUMN weight_text TEXT
  CHECK (weight_text IS NULL OR (
    length(weight_text) >= 6
    AND weight_text NOT GLOB '*[^0-9.]*'
    AND instr(weight_text, '.') = length(weight_text) - 4
  ));

CREATE TABLE classification_batch_jobs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_batch_id TEXT UNIQUE,
  input_file_id TEXT,
  output_file_id TEXT,
  error_file_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  confidence_threshold REAL NOT NULL CHECK (confidence_threshold BETWEEN 0 AND 1),
  requested_model TEXT NOT NULL,
  actual_model TEXT,
  prompt_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  total_items INTEGER NOT NULL CHECK (total_items > 0),
  completed_items INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
  failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  submitted_at TEXT,
  finalized_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (completed_items + failed_items <= total_items)
) STRICT;

CREATE TABLE classification_batch_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES classification_batch_jobs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  custom_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, custom_id),
  UNIQUE (job_id, product_id)
) STRICT;

CREATE INDEX classification_batch_items_by_product
  ON classification_batch_items (product_id, job_id);

CREATE TABLE classification_batch_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES classification_batch_jobs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  status TEXT NOT NULL,
  provider_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provider_json)),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX classification_batch_events_by_job
  ON classification_batch_events (job_id, occurred_at, id);

CREATE TRIGGER classification_batch_jobs_no_delete
BEFORE DELETE ON classification_batch_jobs
BEGIN
  SELECT RAISE(ABORT, 'classification batch jobs are append-only lifecycle evidence');
END;

CREATE TRIGGER classification_batch_items_no_update
BEFORE UPDATE ON classification_batch_items
BEGIN
  SELECT RAISE(ABORT, 'classification batch items are immutable');
END;

CREATE TRIGGER classification_batch_items_no_delete
BEFORE DELETE ON classification_batch_items
BEGIN
  SELECT RAISE(ABORT, 'classification batch items are append-only');
END;

CREATE TRIGGER classification_batch_events_no_update
BEFORE UPDATE ON classification_batch_events
BEGIN
  SELECT RAISE(ABORT, 'classification batch events are immutable');
END;

CREATE TRIGGER classification_batch_events_no_delete
BEFORE DELETE ON classification_batch_events
BEGIN
  SELECT RAISE(ABORT, 'classification batch events are append-only');
END;
