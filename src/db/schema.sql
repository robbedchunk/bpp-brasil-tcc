CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS retailers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  cep TEXT NOT NULL,
  platform_hint TEXT,
  domains_json TEXT NOT NULL CHECK (json_valid(domains_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
  degraded_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS ipca_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  parent_code TEXT,
  name TEXT NOT NULL,
  item_group TEXT NOT NULL DEFAULT 'alimentacao_no_domicilio',
  weight REAL NOT NULL CHECK (weight >= 0),
  weight_period TEXT NOT NULL,
  source_url TEXT NOT NULL,
  citation TEXT NOT NULL,
  in_scope INTEGER NOT NULL DEFAULT 1 CHECK (in_scope IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('discovery', 'extraction')),
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
  version INTEGER NOT NULL CHECK (version > 0),
  strategy_json TEXT NOT NULL CHECK (json_valid(strategy_json)),
  provenance TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  validation_sample_size INTEGER NOT NULL DEFAULT 0 CHECK (validation_sample_size >= 0),
  validation_successes INTEGER NOT NULL DEFAULT 0 CHECK (
    validation_successes >= 0 AND validation_successes <= validation_sample_size
  ),
  validation_rate REAL CHECK (validation_rate BETWEEN 0 AND 1),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  validated_at TEXT,
  activated_at TEXT,
  retired_at TEXT,
  UNIQUE (retailer_id, purpose, version)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_strategy_per_retailer_purpose
  ON strategies (retailer_id, purpose)
  WHERE active = 1;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  canonical_url TEXT NOT NULL,
  retailer_product_id TEXT,
  title TEXT NOT NULL,
  brand TEXT,
  source_category TEXT,
  raw_unit TEXT,
  quantity_value REAL CHECK (quantity_value IS NULL OR quantity_value > 0),
  quantity_unit TEXT,
  base_quantity REAL CHECK (base_quantity IS NULL OR base_quantity > 0),
  base_unit TEXT,
  current_ipca_item_id TEXT REFERENCES ipca_items(id) ON UPDATE CASCADE ON DELETE SET NULL,
  in_scope INTEGER NOT NULL DEFAULT 1 CHECK (in_scope IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (retailer_id, canonical_url)
) STRICT;

CREATE INDEX IF NOT EXISTS products_by_retailer_last_seen
  ON products (retailer_id, last_seen DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  retailer_id TEXT REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (length(stage) > 0),
  collection_day TEXT NOT NULL,
  strategy_id TEXT REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  strategy_version INTEGER CHECK (strategy_version IS NULL OR strategy_version > 0),
  status TEXT NOT NULL CHECK (length(status) > 0),
  attempted INTEGER NOT NULL DEFAULT 0 CHECK (attempted >= 0),
  ok INTEGER NOT NULL DEFAULT 0 CHECK (ok >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_category TEXT,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (attempted = ok + failed)
) STRICT;

CREATE INDEX IF NOT EXISTS runs_by_retailer_stage_day
  ON runs (retailer_id, stage, collection_day DESC, finished_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  strategy_id TEXT REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  strategy_version INTEGER CHECK (strategy_version IS NULL OR strategy_version > 0),
  observed_at TEXT NOT NULL,
  collection_day TEXT NOT NULL,
  title TEXT,
  brand TEXT,
  source_category TEXT,
  raw_unit TEXT,
  quantity_value REAL CHECK (quantity_value IS NULL OR quantity_value > 0),
  quantity_unit TEXT,
  base_quantity REAL CHECK (base_quantity IS NULL OR base_quantity > 0),
  base_unit TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  promo_price_cents INTEGER CHECK (promo_price_cents IS NULL OR promo_price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  response_path TEXT,
  response_sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (promo_price_cents IS NULL OR promo_price_cents <= price_cents)
) STRICT;

CREATE INDEX IF NOT EXISTS observations_by_product_day
  ON observations (product_id, collection_day DESC, observed_at DESC);

CREATE TABLE IF NOT EXISTS run_failures (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  retailer_id TEXT REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_id TEXT REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  canonical_url TEXT,
  category TEXT NOT NULL,
  message TEXT,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  strategy_id TEXT REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  strategy_version INTEGER CHECK (strategy_version IS NULL OR strategy_version > 0),
  response_path TEXT,
  response_sha256 TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS run_failures_by_run_category
  ON run_failures (run_id, category);

CREATE TABLE IF NOT EXISTS classifications (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ipca_item_id TEXT REFERENCES ipca_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  decision TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  method TEXT NOT NULL,
  rule_version TEXT,
  prompt_version TEXT,
  model TEXT,
  input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
  output_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(output_json)),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (product_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS exploration_runs (
  id TEXT PRIMARY KEY,
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('discovery', 'extraction')),
  trigger TEXT NOT NULL,
  previous_strategy_id TEXT REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  candidate_strategy_id TEXT REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  status TEXT NOT NULL,
  outcome TEXT,
  event_budget INTEGER NOT NULL CHECK (event_budget > 0),
  events_used INTEGER NOT NULL DEFAULT 0 CHECK (events_used >= 0 AND events_used <= event_budget),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  sandbox_id TEXT,
  artifact_json TEXT CHECK (artifact_json IS NULL OR json_valid(artifact_json)),
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS healing_events (
  id TEXT PRIMARY KEY,
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('discovery', 'extraction')),
  onset_run_id TEXT REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  previous_strategy_id TEXT REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  successor_strategy_id TEXT REFERENCES strategies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  tier_from INTEGER CHECK (tier_from IS NULL OR tier_from BETWEEN 1 AND 4),
  tier_to INTEGER CHECK (tier_to IS NULL OR tier_to BETWEEN 1 AND 4),
  drift_started_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  recovered_at TEXT,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  retailer_id TEXT REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  run_id TEXT REFERENCES runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  scheduled_for TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS heartbeats_by_pipeline_completion
  ON heartbeats (pipeline, completed_at DESC);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  retailer_id TEXT REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exploration_run_id TEXT REFERENCES exploration_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  classification_id TEXT REFERENCES classifications(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL CHECK (cost_usd >= 0),
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS cost_ledger_by_occurred_at
  ON cost_ledger (occurred_at DESC);
