# Task 10 report — São Paulo IPCA reference and incremental classification

## Status

Implemented and production-loaded. Feature commit: `a44b1ac` (`feat(m3): load IPCA items and classify products`). The production SQLite mutation is intentionally not part of the source commit: `data/precos.sqlite` now contains the loaded reference rows and migration 3, while live collection evidence remains unchanged.

The live LLM acceptance gate is honestly pending because neither `OPENAI_API_KEY` nor `CODEX_API_KEY` is configured. No cached interactive authentication, fake result, or model evidence was used.

## TDD evidence

The requested `superpowers:test-driven-development` workflow was followed.

RED observations, each seen before its production change:

1. `npm test -- tests/classify` failed both suites because `src/classify/classify.ts` and `src/classify/openai-provider.ts` did not exist.
2. The budget test failed with `budgetGuard.estimateModelCost is not a function`.
3. The official-artifact integration failed because the production area label is `São Paulo (SP)`, exposing the shorthand used by the first fixture.
4. The review-export regression failed because `classify --review-sample 200` emitted a human summary rather than exportable JSON.
5. The versioning regression showed `decision` held internal item IDs instead of stable seven-digit SNIPC codes.
6. The usage-audit regression showed a response with `usage: null` was incorrectly accepted as zero tokens.

Each was followed by the minimal implementation and a focused GREEN run. Final Node 24 results:

- `npm run typecheck`: pass.
- standalone strict typecheck of `scripts/load-ipca-items.ts`: pass.
- `npm test -- tests/classify tests/ops/budget.test.ts`: pass (28 focused tests after the final usage regression).
- `npm test`: pass, 33 files and 226 tests.
- `npm run build`: pass.
- `git diff --check`: pass.

## Official reference artifact

Numeric source: IBGE's final December 2019 POF archive, `Estrutura_IPCA.xlsx`, sheet `SP`.

- Archive SHA-256: `0ba845113682c96015a0e93daf4b10bc93aad82c2c1d6ea406282af958bf9104`.
- Workbook SHA-256: `2f6b759b3dfc4c38ebc791afc5c7e5e7a0b77b90c40f646246f4878a3dc4be4a`.
- Committed CSV SHA-256: `61698e58615d5bb37790cc5e0a3e8206866eeeb9895a1a941588d92b6f1b54fd`.
- Rows / unique SNIPC codes / unique SIDRA category IDs: `84 / 84 / 84`.
- Workbook-to-SIDRA code joins: `84/84`; nine description differences are hyphen-spacing only and names are not join keys.
- Weight sum: exactly `12.1181` percent of total São Paulo IPCA.
- BCB EE069 is documented only as methodological context/cross-check; it is not the numeric subitem source.

The CSV retains the exact required 15-column provenance layout. SNIPC, SIDRA category, area, and subgroup codes remain strings. Migration 3 adds the provenance fields to `ipca_items`; the loader validates exact columns, 84 rows, duplicate/non-food/negative/missing-citation/hash failures, and the `12.1181 ± 0.0001` total before one immediate idempotent transaction.

The reference README states that future index exports must retain `covered_weight_pct_total_ipca` and `covered_weight_pct_total_ipca / 12.1181`, renormalizing only covered rows.

## Classification implementation

- `ProductClassifier.classify` receives only product ID, title, nullable brand, nullable source category, and the allowed IPCA item list.
- The OpenAI adapter pins `openai@6.46.0`, uses `responses.parse`, `zodTextFormat`, a strict root Zod object, required nullable `ipcaItemId`, `store: false`, default model `gpt-5.6-luna`, and host validation for one result per unique input ID plus allowed-item membership.
- SDK retries are disabled; the adapter retries at most three times and only for network/transient HTTP 408/409/429/5xx failures. Schema, refusal, authentication, and host-validation failures are not retried.
- Prompt version and SHA-256, model, exact token usage, raw output, confidence, rationale code, and estimated cost are retained. Missing usage is rejected.
- The budget guard applies a dated, explicitly estimated token-price table before each nonessential batch. Cost and token totals are allocated deterministically across append-only classification/cost rows; the allocation remains marked `estimated`.
- Products are selected incrementally by absent `(product_id, version)` evidence and processed deterministically in default batches of 50. Reclassification inserts a higher version; immutable prior evidence remains. Only the current product classification pointer (and its update timestamp) changes.
- Low-confidence suggestions are retained in raw output evidence but store a null item pointer and `unclassified` decision.
- `--dry-run` performs no provider call and no classification/cost write. `--review-sample` emits deterministic SHA-256-ranked, round-robin stratified JSON capped at 200 rows.
- No classification work was added to the blocking daily collection path. The asynchronous Batch API is reserved for a separately invoked initial-backfill/reclassification workflow and is not used as a daily-pipeline dependency.

Pinned additions are exactly `openai@6.46.0`, `csv-parse@7.0.1`, and `decimal.js@10.6.0`.

## Production acceptance

Before loading: migrations `2`, IPCA rows `0`, products `60`, classifications `0`, classification-cost rows `0`, runs `8`, observations `62`, failures `60`, heartbeats `1`, integrity `ok`.

`npm run ipca:load` was run twice against `data/precos.sqlite`; both runs reported:

```json
{"loaded":84,"totalWeight":"12.1181"}
```

Post-load query: migration `3`; IPCA rows/distinct codes `84/84`; sum `12.1181`; missing archive provenance `0`; area code `3501`; one subgroup `1100000`; integrity and foreign keys clean.

Production dry-run:

```json
{"dryRun":true,"version":1,"confidenceThreshold":0.8,"batchSize":50,"plannedBatches":2,"batches":0,"eligible":60,"classified":0,"unclassified":0,"pending":60,"budgetDenied":0,"estimatedCostUsd":0,"status":"dry_run"}
```

Explicit no-key non-dry acceptance reported `provider_unavailable`, `eligible: 60`, `pending: 60`, and wrote one sanitized warning to the private local fallback `var/log/alerts.jsonl`. Post-checks still show classifications `0`, classification-cost rows `0`, and non-null product pointers `0`.

Collection evidence stayed at 8 runs, 62 observations, 60 failures, and 1 heartbeat. `precos-daily.timer`, `precos-weekly-discovery.timer`, `precos-heartbeat.timer`, and `precos-backup.timer` all remain enabled and active.

## Remaining gate / concerns

The only acceptance gate is a real provider call after an operator supplies an API key and explicitly authorizes spend. Until then, all 60 current products correctly remain pending. No collection process was stopped or modified, and no secret value was printed or persisted.
