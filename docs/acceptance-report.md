# Full Charter Acceptance Report

Generated: 2026-07-26T18:55:24.254Z
Evaluated implementation commit: `5667e621a0e99459a47271e9f21cbf2282277fe7`
Overall status: **PENDING**

This report records evidence without converting external time, credential, site, or author gates into success.

## Milestones

| Milestone | Status | Criterion | Reason codes |
| --- | --- | --- | --- |
| M0 | PASS | Clean-clone receipt, declared runtime, migrations, and read-only database checks pass | — |
| M1 | PASS | Offline normalization, extraction, discovery, and retailer safety suites pass | — |
| M2 | PENDING | Two consecutive qualifying collection days have not yet matured | TIME_WINDOW_NOT_ELAPSED |
| M3 | PENDING | The live panel awaits its first substantive scheduled collection | SCHEDULED_RUN_NOT_YET_DUE |
| M3 | PASS | Latest-version high-confidence classification covers at least 80% of classification-eligible active products | — |
| M3 | PASS | A completed 200-row human review is bound to the current classification version | — |
| M3 | PASS | Every active strategy has a published, identity-bound 30-sample validation receipt | — |
| M3 | PASS | Post-collection classification automation is installed and current | — |
| M4 | PASS | The Codex SDK mechanism is wired behind trusted strategy acceptance; live generation provenance is not a delivery requirement | — |
| M5 | PASS | Deterministic sabotage, automatic healing, recovery, and the installed worker pass without requiring live model provenance | — |
| M6 | PENDING | Current artifacts are valid but a nonempty official overlap comparison is not yet available | OFFICIAL_OVERLAP_NOT_AVAILABLE |
| M7 | PENDING | The first applicable scheduled daily/backup windows have not both elapsed | SCHEDULED_RUN_NOT_YET_DUE |

## Pending gates

- **m2-two-consecutive-days — TIME_WINDOW_NOT_ELAPSED (time)**: Let the installed daily schedule collect the next real São Paulo calendar day Recheck with `npm run acceptance -- --json`.
- **m3-live-panel — SCHEDULED_RUN_NOT_YET_DUE (time)**: Let the installed daily schedule collect every active retailer with a healthy substantive run Recheck with `npm run acceptance -- --json`.
- **m6-index-analysis — OFFICIAL_OVERLAP_NOT_AVAILABLE (time)**: Collect through an overlapping closed official month, then regenerate the comparison Recheck with `npm run research:snapshot && npm run acceptance -- --json`.
- **m7-publication-operations — SCHEDULED_RUN_NOT_YET_DUE (time)**: Let both installed São Paulo schedules reach their first real windows Recheck with `npm run acceptance -- --json`.

## Evidence index

- `command-m1-offline` — command, source `m1-offline`, SHA-256 `7ac62df6249791c30dd20d7aaee9b8cc0a26f35b25617a0d7f8080bcc776dde5`.
- `command-m4-agent-capability` — command, source `m4-agent-capability`, SHA-256 `63cbee4ee13a8578699623f3e98ed82c1f1980ffccd5c305a0575924a3542506`.
- `command-m5-healing` — command, source `m5-healing`, SHA-256 `6ac00a5c9aa9557b9dbb1930d571be16a4f05cd4783697582b7f2730a7d4e6c3`.
- `command-m6-index-analysis` — command, source `m6-index-analysis`, SHA-256 `9adbf9fb22e569f3207573361f3bd9d8067927300cb68efbc1705ac0aa0d99bc`.
- `db-m2-heartbeat-linked-collection-runs` — database-query, source `m2-heartbeat-linked-collection-runs`.
- `db-m3-latest-classification-coverage` — database-query, source `m3-latest-classification-coverage`.
- `db-m3-live-panel` — database-query, source `m3-live-panel`.
- `file-m1-fixture-inventory` — file, source `tests/fixtures`.
- `file-m3-active-strategy-validation-receipts` — file, source `data/validation`, SHA-256 `8bdc84a68d15847e06d470defb7d895bf5871990b190066a95c2427b326e7905`.
- `file-m3-classification-human-review` — file, source `data/acceptance/evidence/classification-review-v1.json`, SHA-256 `51ed17e93cf74d592e75d4892977fea50a17bde94df78a1161b455e3e41293f6`.
- `file-m5-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `file-m6-current-binding` — file, source `data/exports/latest.json+analysis/output/latest.json`, SHA-256 `f622cf71cee472ddfdd51e35a3af22725b78432a82109baa33300a50dde0584f`.
- `file-m6-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `file-m7-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `receipt-m0-fresh-clone` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `8f304fbba17b131c74457a4e68e6636e8d344cd996c1e12772dbce7a2100ae2b`.
- `receipt-m6-analysis-regenerate` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `8f304fbba17b131c74457a4e68e6636e8d344cd996c1e12772dbce7a2100ae2b`.
- `service-m3-classification-automation` — service, source `precos-classification.service`.
- `service-m7-publication-operations` — service, source `m7-publication-and-six-timers`.

## Publication boundary

Publication audit: **PASS**; findings: 0.

