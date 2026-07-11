# Public data dictionary

## Conventions

- SQLite timestamps are ISO 8601 UTC strings; `collection_day` is a strict
  São Paulo `YYYY-MM-DD` calendar date.
- BRL prices are integer centavos. Public ratios/weights use canonical decimal
  strings, not locale commas.
- Null means unavailable/not observed/not applicable; it is never silently zero.
- Strategy, run, observation, failure, classification, exploration, healing,
  heartbeat, cost, and batch evidence is append-only except documented lifecycle
  finalization fields. Products retain mutable current catalog state.

## SQLite tables

| Table | Public meaning |
|---|---|
| `retailers` | Retailer identity, base URL, CEP, domains, active/degraded state. |
| `strategies` | Typed discovery/extraction versions, validation, provenance, lifecycle. |
| `products` | Canonical retailer product identity and current classification pointer. |
| `observations` | Collected title/unit/availability and regular/promo cent values. |
| `runs` | Per-retailer/stage operational counts and terminal state. |
| `run_failures` | Categorized attempt evidence; public exports omit message/URL/replay fields. |
| `ipca_items` | 84 cited São Paulo food-at-home sub-items and exact POF weights. |
| `classifications` | Versioned item decisions, confidence, method/model/usage evidence. |
| `classification_batch_jobs/items/events` | Asynchronous classification lifecycle. |
| `exploration_runs` | Strategy-generation event budget, result, usage, and cost. |
| `exploration_attempts` | Immutable per-attempt prompt/model/validation evidence. |
| `model_budget_reservations` | Concurrent exploration budget commitments/settlement. |
| `exploration_recovery_adjustments` | Append-only reconciliation after interrupted work. |
| `healing_events` | Drift onset, attempts, recovery, successor, tier change, duration. |
| `heartbeats` | Completed scheduled-pipeline evidence. |
| `cost_ledger` | Model/classification usage and estimated/actual USD evidence. |
| `schema_migrations` | Applied forward-only migration versions. |

`response_path`/`response_sha256` are replay metadata, not response bodies. A
public database must contain no raw HTML, credential, personal data, or private
absolute path. A non-null path may refer only to an ignored, untracked runtime
root; the target archive is never public.

## Research CSV snapshot

Each immutable directory beneath `data/exports/snapshots/` contains a strict
manifest and the exact schemas below. In the column lists, `text`, `id`, and
`enum` are UTF-8 strings; `date` is São Paulo `YYYY-MM-DD`; `timestamp` is UTC
ISO 8601; `count` is a non-negative integer; `ratio` is dimensionless; `BRL
centavos` is an integer; `percent` is percentage points; and `USD` is dollars.
`nullable` is stated explicitly; every other column is required and non-null.

| File | Exact ordered columns, unit, and null meaning |
|---|---|
| `product_relatives.csv` | `date` (date); `previous_date` (date); `retailer_id`, `product_id`, `ipca_item_id`, `ipca_code`, `classification_id` (id); `classification_version` (count); `numerator_cents`, `denominator_cents` (BRL centavos); `numerator_source_date`, `denominator_source_date` (date); `numerator_carried`, `denominator_carried` (boolean); `relative` (ratio). No nullable columns. |
| `retailer_subitem_daily.csv` | `date`, `previous_date` (date); `retailer_id`, `ipca_item_id`, `ipca_code` (id); `retailer_name` (text); `relative` (Jevons ratio); `product_pair_count` (count). No nullable columns. |
| `subitem_daily.csv` | `date`, `previous_date` (date); `ipca_item_id`, `ipca_code` (id); `ipca_name` (text); `weight_pct_total_ipca` (percent); `relative` (equal-retailer ratio); `retailer_count`, `product_pair_count` (count); `retailer_min_relative`, `retailer_max_relative` (ratio). No nullable columns. |
| `aggregate_daily.csv` | `date`, `previous_date` (date); `chain_segment` (count); `daily_relative`, `index_level` (ratio/index points); `covered_weight_pct_total_ipca`, `total_food_at_home_weight_pct_total_ipca` (percent); `coverage_fraction` (ratio); `covered_subitem_count`, `retailer_count`, `product_pair_count` (count); `descriptive_low_relative`, `descriptive_high_relative` (ratio); `method_version` (text). No nullable columns. |
| `coverage_daily.csv` | `date` (date); `covered_weight_pct_total_ipca`, `total_food_at_home_weight_pct_total_ipca` (percent); `coverage_fraction` (ratio); `covered_subitem_count`, `retailer_count`, `product_pair_count`, `unclassified_count`, `no_healthy_run_count`, `unavailable_count`, `carried_expired_count`, `no_denominator_count`, `invalid_price_count` (count). No nullable columns. |
| `official_ipca_monthly.csv` | `month` (`YYYY-MM`); `variation_pct` (percent); `variable_id`, `territorial_level`, `area_code`, `classification_id`, `category_id` (id); `area_name` (text); `source_url` (public IBGE URL); `source_response_sha256` (SHA-256). No nullable columns. |
| `monthly_comparison.csv` | `month` (`YYYY-MM`); `experimental_variation_pct` (percent, nullable when the experimental month is not closed); `official_variation_pct` (percent, nullable when SIDRA has no overlapping month); `status` (enum explaining either null); `experimental_chain_segment` (count, nullable with missing experimental variation). |
| `runs.csv` | `run_id`, `retailer_id`, `strategy_id` (id; `strategy_id` nullable when the stage has no strategy); `retailer_name` (text); `collection_day` (date); `stage`, `status` (enum); `attempted`, `ok`, `failed` (count); `success_rate` (ratio); `strategy_version` (count, nullable with `strategy_id`); `started_at`, `finished_at` (timestamp; `finished_at` nullable only for an in-progress snapshot); `error_category` (enum, nullable when no terminal run error). |
| `failures.csv` | `collection_day` (date); `retailer_id`, `run_id` (id); `retailer_name` (text); `category` (enum); `count` (count). No nullable columns. |
| `healing_events.csv` | `event_id`, `retailer_id`, `onset_run_id`, `previous_strategy_id` (id); `retailer_name` (text); `purpose`, `status` (enum); `successor_strategy_id` (id, nullable until recovery/failure); `attempts` (count); `tier_from`, `tier_to` (tier enum, each nullable when unavailable/not yet recovered); `drift_started_at`, `detected_at` (timestamp); `recovered_at` (timestamp, nullable until recovery); `duration_seconds` (seconds, nullable until terminal). |
| `model_costs.csv` | `month` (`YYYY-MM`); `retailer_id` (id, nullable for non-retailer/shared work); `category`, `provider`, `model` (text/enum); `input_tokens`, `output_tokens`, `event_count` (count); `cost_usd` (USD). |
| `classification_coverage.csv` | `retailer_id` (id); `retailer_name` (text); `total_in_scope_products`, `classified_products`, `unclassified_products` (count); `classification_rate` (ratio); `latest_version` (count, nullable when no classification has been recorded). |

Public CSVs exclude product URLs, failure messages, every JSON payload, replay
paths/hashes, raw HTML, cookies, authorization, environment paths, and secrets.

## Analysis and acceptance artifacts

`analysis/output/snapshots/` contains deterministic PNG/CSV outputs and a
manifest derived only from verified public CSVs. `data/acceptance/` contains a
sanitized machine report and drill receipts. Private alert lines, backup files,
temporary clones, command output, topics, and absolute paths are not included.
