CREATE TABLE exploration_attempts (
  id TEXT PRIMARY KEY,
  exploration_run_id TEXT NOT NULL REFERENCES exploration_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL CHECK (
    length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_output_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  cost_estimated INTEGER NOT NULL CHECK (cost_estimated IN (0, 1)),
  estimate_source TEXT NOT NULL,
  rate_version TEXT NOT NULL,
  external_sample_size INTEGER CHECK (external_sample_size IS NULL OR external_sample_size >= 0),
  external_successes INTEGER CHECK (
    external_successes IS NULL OR (
      external_successes >= 0
      AND external_sample_size IS NOT NULL
      AND external_successes <= external_sample_size
    )
  ),
  external_score REAL CHECK (external_score IS NULL OR external_score BETWEEN 0 AND 1),
  outcome TEXT NOT NULL,
  artifact_json TEXT CHECK (artifact_json IS NULL OR json_valid(artifact_json)),
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (exploration_run_id, attempt_number)
) STRICT;

CREATE INDEX exploration_attempts_by_run
  ON exploration_attempts (exploration_run_id, attempt_number);

CREATE TRIGGER exploration_attempts_no_update
BEFORE UPDATE ON exploration_attempts
BEGIN
  SELECT RAISE(ABORT, 'exploration attempts are immutable');
END;

CREATE TRIGGER exploration_attempts_no_delete
BEFORE DELETE ON exploration_attempts
BEGIN
  SELECT RAISE(ABORT, 'exploration attempts are append-only');
END;
