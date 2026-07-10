ALTER TABLE classification_batch_jobs
ADD COLUMN projected_cost_usd REAL NOT NULL DEFAULT 0
CHECK (projected_cost_usd >= 0);

ALTER TABLE classification_batch_jobs
ADD COLUMN actual_cost_usd REAL
CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0);

ALTER TABLE classification_batch_jobs
ADD COLUMN provider_errors_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(provider_errors_json));
