# Full Charter Acceptance Report

Generated: 2026-07-11T15:07:19.148Z
Evaluated implementation commit: `74c4932285fe4771893ff6dc1a4b7ea2fb39f0bb`
Overall status: **PENDING**

This report records evidence without converting external time, credential, site, or author gates into success.

## Milestones

| Milestone | Status | Criterion | Reason codes |
| --- | --- | --- | --- |
| M0 | PASS | Clean-clone receipt, declared runtime, migrations, and read-only database checks pass | — |
| M1 | PASS | Offline normalization, extraction, discovery, and retailer safety suites pass | — |
| M2 | PENDING | Two consecutive qualifying collection days have not yet matured | TIME_WINDOW_NOT_ELAPSED |
| M3 | PENDING | The live panel awaits its first substantive scheduled collection | SCHEDULED_RUN_NOT_YET_DUE |
| M3 | PENDING | High-confidence classification coverage remains credential-gated | CREDENTIAL_NOT_CONFIGURED |
| M3 | PENDING | The classification precision check awaits an explicit human review | AUTHORITY_APPROVAL_REQUIRED |
| M3 | PASS | Every active strategy has a published, identity-bound 30-sample validation receipt | — |
| M3 | PASS | Post-collection classification automation is installed and current | — |
| M4 | PENDING | Live strategy generation remains externally gated; acceptance made no provider call | CREDENTIAL_NOT_CONFIGURED |
| M5 | PENDING | Offline healing checks pass only as supporting evidence; the genuine staging sabotage drill is still pending | CREDENTIAL_NOT_CONFIGURED |
| M6 | PENDING | Reproducible artifacts are valid but the experimental daily relative series has not started | TIME_WINDOW_NOT_ELAPSED |
| M7 | PENDING | The first applicable scheduled daily/backup windows have not both elapsed | SCHEDULED_RUN_NOT_YET_DUE |

## Pending gates

- **m2-two-consecutive-days — TIME_WINDOW_NOT_ELAPSED (time)**: Let the installed daily schedule collect the next real São Paulo calendar day Recheck with `npm run acceptance -- --json`.
- **m3-classification-coverage — CREDENTIAL_NOT_CONFIGURED (credential)**: Configure the classification credential privately, then run the normal reviewed classification workflow Recheck with `npm run acceptance -- --json`.
- **m3-classification-human-review — AUTHORITY_APPROVAL_REQUIRED (authority)**: Run scripts/classification-review.ts export, have the author label every row, then run its evaluate command Recheck with `npm run acceptance -- --json`.
- **m3-live-panel — SCHEDULED_RUN_NOT_YET_DUE (time)**: Let the installed daily schedule collect every active retailer with a healthy substantive run Recheck with `npm run acceptance -- --json`.
- **m4-live-agent-strategies — CREDENTIAL_NOT_CONFIGURED (credential)**: Configure the model credential privately; acceptance will not invoke the provider Recheck with `npm run acceptance -- --json`.
- **m5-automatic-healing — CREDENTIAL_NOT_CONFIGURED (credential)**: Configure the explorer credential privately; acceptance will not invoke a provider Recheck with `npm run acceptance:healing-drill -- --confirm-staging-sabotage --authorize-live-spend-usd 5`.
- **m6-index-analysis — TIME_WINDOW_NOT_ELAPSED (time)**: Collect and classify enough consecutive observations to produce product relatives and at least one aggregate daily relative Recheck with `npm run research:snapshot && npm run acceptance -- --json`.
- **m7-publication-operations — SCHEDULED_RUN_NOT_YET_DUE (time)**: Let both installed São Paulo schedules reach their first real windows Recheck with `npm run acceptance -- --json`.

## Evidence index

- `command-m1-offline` — command, source `m1-offline`, SHA-256 `1e28fc945ac97d101d3b99d9eaec92f4e92c8926cdea6dc21b29a4b22a83a2f6`.
- `command-m5-healing` — command, source `m5-healing`, SHA-256 `9a059a7bd9948e8b5d2b5de80020593be486c3096c5c293dea71579d05d809a8`.
- `command-m6-index-analysis` — command, source `m6-index-analysis`, SHA-256 `96c097b55f01dd106d64223501c8f01f24b004db1533762f385dcb1c7498a44c`.
- `db-m2-heartbeat-linked-collection-runs` — database-query, source `m2-heartbeat-linked-collection-runs`.
- `db-m3-latest-classification-coverage` — database-query, source `m3-latest-classification-coverage`.
- `db-m3-live-panel` — database-query, source `m3-live-panel`.
- `db-m4-agent-activated-strategies` — database-query, source `m4-agent-activated-strategies`.
- `file-m1-fixture-inventory` — file, source `tests/fixtures`.
- `file-m3-active-strategy-validation-receipts` — file, source `data/validation`, SHA-256 `284cec8e9046d294e6c84ded889799a72d719fb3263ce8feaf3bcb703e114e59`.
- `file-m3-classification-human-review` — file, source `data/acceptance/evidence/classification-review-vN.json`.
- `file-m5-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `file-m6-current-binding` — file, source `data/exports/latest.json+analysis/output/latest.json`, SHA-256 `5c498737b14f53008bb079761efddb97aacae4a1f977b035f40ca1efd5218ecf`.
- `file-m6-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `file-m7-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `receipt-m0-fresh-clone` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `51207454c606157a3695deb14dc27ff5a3a5dedc1d7a0338a161f35480b49ef2`.
- `receipt-m5-installed-release-healing-sabotage` — receipt, source `data/acceptance/evidence/healing-sabotage-drill.json`.
- `receipt-m6-analysis-regenerate` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `51207454c606157a3695deb14dc27ff5a3a5dedc1d7a0338a161f35480b49ef2`.
- `service-m3-classification-automation` — service, source `precos-classification.service`.
- `service-m7-publication-operations` — service, source `m7-publication-and-six-timers`.

## Publication boundary

Publication audit: **PASS**; findings: 0.

