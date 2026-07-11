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
manifest and these schemas:

- `product_relatives.csv`: product/day numerator, denominator, carry flags,
  classification evidence, relative;
- `retailer_subitem_daily.csv`: Jevons relative and pair count per retailer/item;
- `subitem_daily.csv`: equal-retailer relative, source weight, counts, descriptive
  retailer range;
- `aggregate_daily.csv`: daily relative, chain segment/level, coverage and method;
- `coverage_daily.csv`: covered weight/items/retailers/pairs and exclusion counts;
- `official_ipca_monthly.csv`: exact validated SIDRA monthly values/provenance;
- `monthly_comparison.csv`: closed-month experimental/official changes/status;
- `runs.csv`: aggregate-safe operational run fields;
- `failures.csv`: failure counts by day/retailer/run/category;
- `healing_events.csv`: healing lifecycle without private payloads;
- `model_costs.csv`: monthly/provider/model usage and USD totals;
- `classification_coverage.csv`: active in-scope classification counts/rate.

Public CSVs exclude product URLs, failure messages, every JSON payload, replay
paths/hashes, raw HTML, cookies, authorization, environment paths, and secrets.

## Analysis and acceptance artifacts

`analysis/output/snapshots/` contains deterministic PNG/CSV outputs and a
manifest derived only from verified public CSVs. `data/acceptance/` contains a
sanitized machine report and drill receipts. Private alert lines, backup files,
temporary clones, command output, topics, and absolute paths are not included.
