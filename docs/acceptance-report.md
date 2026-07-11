# Full Charter Acceptance Report

Generated: 2026-07-11T07:38:42.523Z
Evaluated implementation commit: `fbcf656497c61c6d6cef3b703c08f7912ac0167e`
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

- `command-m1-offline` — command, source `m1-offline`, SHA-256 `ffd57bb733f503457701a052371af6784db9ff30b4213df100abd4190ab296ae`.
- `command-m5-healing` — command, source `m5-healing`, SHA-256 `57362d7c39309747462cf87d22aa09cf2ebce317f5f4fc87f96845dd909e17f6`.
- `command-m6-index-analysis` — command, source `m6-index-analysis`, SHA-256 `0de9cbc3b6540ecdb8c18edca522ccd4836d286370c15ab81873bdab3192f5b6`.
- `db-m2-heartbeat-linked-collection-runs` — database-query, source `m2-heartbeat-linked-collection-runs`.
- `db-m3-latest-classification-coverage` — database-query, source `m3-latest-classification-coverage`.
- `db-m3-live-panel` — database-query, source `m3-live-panel`.
- `db-m4-agent-activated-strategies` — database-query, source `m4-agent-activated-strategies`.
- `file-m1-fixture-inventory` — file, source `tests/fixtures`.
- `file-m3-active-strategy-validation-receipts` — file, source `data/validation`, SHA-256 `c650d2bc1a852ada3421f133d470a4a7121c577b9a1f1451b1549dab4fa90a10`.
- `file-m3-classification-human-review` — file, source `data/acceptance/evidence/classification-review-vN.json`.
- `file-m5-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `file-m6-current-binding` — file, source `data/exports/latest.json+analysis/output/latest.json`, SHA-256 `90f40fe3e0cc62e52be8ed1a44336c95988e3d80e0fc28251d4e41cfe7367772`.
- `file-m6-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `file-m7-review-findings` — file, source `ops/review-findings.json`, SHA-256 `32b5b03f2510c64c7112ae2efc5a119bf965ef9a160d6bd9f3553bd3dcf40e1d`.
- `receipt-m0-fresh-clone` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `8119142a1275471ab7f0580852427febd804ddc24ad4d06dd7868aeb6681bfc8`.
- `receipt-m6-analysis-regenerate` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `8119142a1275471ab7f0580852427febd804ddc24ad4d06dd7868aeb6681bfc8`.
- `service-m3-classification-automation` — service, source `precos-classification.service`.
- `service-m7-publication-operations` — service, source `m7-publication-and-six-timers`.

## Publication boundary

Publication audit: **PASS**; findings: 0.

