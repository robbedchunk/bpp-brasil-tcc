# Full Charter Acceptance Report

Generated: 2026-07-11T08:26:58.196Z
Evaluated implementation commit: `422dd0620c487aa0abf8f58b63482dcdf883eb89`
Overall status: **PENDING**

This report records evidence without converting external time, credential, site, or author gates into success.

## Milestones

| Milestone | Status | Criterion | Reason codes |
| --- | --- | --- | --- |
| M0 | PASS | Clean-clone receipt, declared runtime, migrations, and read-only database checks pass | — |
| M1 | PASS | Offline normalization, extraction, discovery, and retailer safety suites pass | — |
| M2 | PENDING | Two consecutive qualifying collection days have not yet matured | TIME_WINDOW_NOT_ELAPSED |
| M3 | PASS | The live panel has current substantive scheduled collection evidence | — |
| M3 | PENDING | High-confidence classification coverage remains credential-gated | CREDENTIAL_NOT_CONFIGURED |
| M3 | PENDING | The classification precision check awaits an explicit human review | AUTHORITY_APPROVAL_REQUIRED |
| M3 | PASS | Every active strategy has a published, identity-bound 30-sample validation receipt | — |
| M3 | PASS | Post-collection classification automation is installed and current | — |
| M4 | PENDING | Live strategy generation remains externally gated; acceptance made no provider call | CREDENTIAL_NOT_CONFIGURED |
| M5 | PASS | Isolated sabotage, drift/blocking, recovery, and timer suites pass | — |
| M6 | PENDING | Reproducible artifacts are valid but the experimental daily relative series has not started | TIME_WINDOW_NOT_ELAPSED |
| M7 | PASS | Publication, six timers, safe drills, backup, and heartbeat evidence are current | — |

## Pending gates

- **m2-two-consecutive-days — TIME_WINDOW_NOT_ELAPSED (time)**: Let the installed daily schedule collect the next real São Paulo calendar day Recheck with `npm run acceptance -- --json`.
- **m3-classification-coverage — CREDENTIAL_NOT_CONFIGURED (credential)**: Configure the classification credential privately, then run the normal reviewed classification workflow Recheck with `npm run acceptance -- --json`.
- **m3-classification-human-review — AUTHORITY_APPROVAL_REQUIRED (authority)**: Run scripts/classification-review.ts export, have the author label every row, then run its evaluate command Recheck with `npm run acceptance -- --json`.
- **m4-live-agent-strategies — CREDENTIAL_NOT_CONFIGURED (credential)**: Configure the model credential privately; acceptance will not invoke the provider Recheck with `npm run acceptance -- --json`.
- **m6-index-analysis — TIME_WINDOW_NOT_ELAPSED (time)**: Collect and classify enough consecutive observations to produce product relatives and at least one aggregate daily relative Recheck with `npm run research:snapshot && npm run acceptance -- --json`.

## Evidence index

- `command-m1-offline` — command, source `m1-offline`, SHA-256 `8911e3c8a2bacc2a745defa2f620d04cc13f5e9620f95acfdc71e896dfe938c6`.
- `command-m5-healing` — command, source `m5-healing`, SHA-256 `c270321c2f952fa149169ed0817ca5af2c5f6e9f842d84774b18c559e78aee7a`.
- `command-m6-index-analysis` — command, source `m6-index-analysis`, SHA-256 `fc5d8658897f59e04987cf4b57bd3650dbf5db307932f956b927f4b0121b2f19`.
- `db-m2-heartbeat-linked-collection-runs` — database-query, source `m2-heartbeat-linked-collection-runs`.
- `db-m3-latest-classification-coverage` — database-query, source `m3-latest-classification-coverage`.
- `db-m3-live-panel` — database-query, source `m3-live-panel`.
- `db-m4-agent-activated-strategies` — database-query, source `m4-agent-activated-strategies`.
- `file-m1-fixture-inventory` — file, source `tests/fixtures`.
- `file-m3-active-strategy-validation-receipts` — file, source `data/validation`, SHA-256 `c650d2bc1a852ada3421f133d470a4a7121c577b9a1f1451b1549dab4fa90a10`.
- `file-m3-classification-human-review` — file, source `data/acceptance/evidence/classification-review-vN.json`.
- `file-m5-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `file-m6-current-binding` — file, source `data/exports/latest.json+analysis/output/latest.json`, SHA-256 `99ab35a6bf4541324b5d5ff212969cc0f1694b7dc5ea7ca0cf10d73204a36f34`.
- `file-m6-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `file-m7-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `receipt-m0-fresh-clone` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `6474d5f0aacfb3886acd38c311001cb3e42a7f65f0b47aff0013d985d8a46380`.
- `receipt-m6-analysis-regenerate` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `6474d5f0aacfb3886acd38c311001cb3e42a7f65f0b47aff0013d985d8a46380`.
- `service-m3-classification-automation` — service, source `precos-classification.service`.
- `service-m7-publication-operations` — service, source `m7-publication-and-six-timers`.

## Publication boundary

Publication audit: **PASS**; findings: 0.

