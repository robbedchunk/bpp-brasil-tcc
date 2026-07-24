# Full Charter Acceptance Report

Generated: 2026-07-24T23:52:18.915Z
Evaluated implementation commit: `566c5c16126d6f9e5920071a585279c00b65aa86`
Overall status: **FAIL**

This report records evidence without converting external time, credential, site, or author gates into success.

## Milestones

| Milestone | Status | Criterion | Reason codes |
| --- | --- | --- | --- |
| M0 | FAIL | Foundation or clean-clone reproducibility evidence is missing or invalid | REQUIRED_ARTIFACT_MISSING |
| M1 | FAIL | Offline normalization, extraction, discovery, and retailer safety suites pass | OFFLINE_CHECK_FAILED |
| M2 | PASS | Two retailers have two consecutive qualifying scheduled collection days | — |
| M3 | PASS | The live panel has current substantive scheduled collection evidence | — |
| M3 | PASS | Latest-version high-confidence classification covers at least 80% of active products | — |
| M3 | PENDING | The classification precision check awaits an explicit human review | AUTHORITY_APPROVAL_REQUIRED |
| M3 | PASS | Every active strategy has a published, identity-bound 30-sample validation receipt | — |
| M3 | PASS | Post-collection classification automation is installed and current | — |
| M4 | PENDING | Live strategy generation remains externally gated; acceptance made no provider call | LIVE_SPEND_NOT_AUTHORIZED |
| M5 | FAIL | Isolated sabotage, drift/blocking, recovery, and timer suites pass | OFFLINE_CHECK_FAILED |
| M6 | FAIL | Index/analysis tests or clean-clone one-command regeneration evidence failed | OFFLINE_CHECK_FAILED |
| M7 | FAIL | Publication audit reports a public safety defect | SECRET_OR_PRIVATE_ARTIFACT |

## Pending gates

- **m3-classification-human-review — AUTHORITY_APPROVAL_REQUIRED (authority)**: Run scripts/classification-review.ts export, have the author label every row, then run its evaluate command Recheck with `npm run acceptance -- --json`.
- **m4-live-agent-strategies — LIVE_SPEND_NOT_AUTHORIZED (authority)**: The author must explicitly opt in with LIVE_OPENAI=1 before the normal exploration workflow Recheck with `npm run acceptance -- --json`.

## Evidence index

- `command-m1-offline` — command, source `m1-offline`, SHA-256 `c644f863dcaaee585ab71c056d2e08d068b5fa8353df7a9fb0813d2135fd2858`.
- `command-m5-healing` — command, source `m5-healing`, SHA-256 `38084673a9c0f4f04ec0dbe22ab5d8bdf3c6da924406401328385f73457609ac`.
- `command-m6-index-analysis` — command, source `m6-index-analysis`, SHA-256 `89b4183a5b3a34313d4c0b3024dd54a390ee4378ba6aaf1fe1bc8bb4935d03be`.
- `db-m2-heartbeat-linked-collection-runs` — database-query, source `m2-heartbeat-linked-collection-runs`.
- `db-m3-latest-classification-coverage` — database-query, source `m3-latest-classification-coverage`.
- `db-m3-live-panel` — database-query, source `m3-live-panel`.
- `db-m4-agent-activated-strategies` — database-query, source `m4-agent-activated-strategies`.
- `file-m1-fixture-inventory` — file, source `tests/fixtures`.
- `file-m3-active-strategy-validation-receipts` — file, source `data/validation`, SHA-256 `02f09785a89b697f07af29224b8628dbc15aef9936e17f7740e6aae83b7535a1`.
- `file-m3-classification-human-review` — file, source `data/acceptance/evidence/classification-review-v1.json`.
- `file-m5-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `file-m6-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `file-m7-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `receipt-m0-fresh-clone` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `bec07e13c2a23d245b647c9fe40ce1a1005189dbc8ba2e2fd9bb8c594c48e376`.
- `receipt-m5-installed-release-healing-sabotage` — receipt, source `data/acceptance/evidence/healing-sabotage-drill.json`.
- `receipt-m6-analysis-regenerate` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `bec07e13c2a23d245b647c9fe40ce1a1005189dbc8ba2e2fd9bb8c594c48e376`.
- `service-m3-classification-automation` — service, source `precos-classification.service`.
- `service-m7-publication-operations` — service, source `m7-publication-and-six-timers`.

## Publication boundary

Publication audit: **FAIL**; findings: 6.

