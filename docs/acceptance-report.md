# Full Charter Acceptance Report

Generated: 2026-07-11T13:45:31.507Z
Evaluated implementation commit: `1d3e8ce0421079c511a136aa18414d5e36cb7508`
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

- `command-m1-offline` — command, source `m1-offline`, SHA-256 `b0dfb049cacb5b03219ac5272fde06f2e8dcc8a0eca6bcab26f138455e435f3b`.
- `command-m5-healing` — command, source `m5-healing`, SHA-256 `6143415b85d2e3e4167806174db5afd0f8fb11bbf18d07e1ccc336c73c7b25d0`.
- `command-m6-index-analysis` — command, source `m6-index-analysis`, SHA-256 `51f6e6921b7e098973a6b715eb919c35fc16b10e437086a1cf943ed7392a51e9`.
- `db-m2-heartbeat-linked-collection-runs` — database-query, source `m2-heartbeat-linked-collection-runs`.
- `db-m3-latest-classification-coverage` — database-query, source `m3-latest-classification-coverage`.
- `db-m3-live-panel` — database-query, source `m3-live-panel`.
- `db-m4-agent-activated-strategies` — database-query, source `m4-agent-activated-strategies`.
- `file-m1-fixture-inventory` — file, source `tests/fixtures`.
- `file-m3-active-strategy-validation-receipts` — file, source `data/validation`, SHA-256 `01a1c81739711f5df0fe06f3a8661e4c2c8c718b516d64213ff97128547cfe2c`.
- `file-m3-classification-human-review` — file, source `data/acceptance/evidence/classification-review-vN.json`.
- `file-m5-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `file-m6-current-binding` — file, source `data/exports/latest.json+analysis/output/latest.json`, SHA-256 `2a0538d78a876e7956333b8ecb630de865d4279eda6d1d53f7abc79eea741d51`.
- `file-m6-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `file-m7-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `receipt-m0-fresh-clone` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `0925db3c65efa80545996a9abfeaee3140ade8aadcaccd38692e511910e9c84b`.
- `receipt-m5-installed-release-healing-sabotage` — receipt, source `data/acceptance/evidence/healing-sabotage-drill.json`.
- `receipt-m6-analysis-regenerate` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `0925db3c65efa80545996a9abfeaee3140ade8aadcaccd38692e511910e9c84b`.
- `service-m3-classification-automation` — service, source `precos-classification.service`.
- `service-m7-publication-operations` — service, source `m7-publication-and-six-timers`.

## Publication boundary

Publication audit: **PASS**; findings: 0.

