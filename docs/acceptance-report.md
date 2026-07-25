# Full Charter Acceptance Report

Generated: 2026-07-25T01:01:24.929Z
Evaluated implementation commit: `1cad20fd9525e64edb2568eb86c9e1c7a295398b`
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
| M3 | FAIL | The strategy-validation receipt registry is malformed or misbound | EVIDENCE_CONTRADICTION |
| M3 | PASS | Post-collection classification automation is installed and current | — |
| M4 | FAIL | The agent API mechanism is implemented, but active strategies did not pass the trusted acceptance boundary | EVIDENCE_CONTRADICTION |
| M5 | PASS | Deterministic sabotage, automatic healing, recovery, and the installed worker pass without requiring live model provenance | — |
| M6 | FAIL | Index/analysis tests or clean-clone one-command regeneration evidence failed | OFFLINE_CHECK_FAILED |
| M7 | FAIL | Publication audit reports a public safety defect | SECRET_OR_PRIVATE_ARTIFACT |

## Pending gates

- **m3-classification-human-review — AUTHORITY_APPROVAL_REQUIRED (authority)**: Run scripts/classification-review.ts export, have the author label every row, then run its evaluate command Recheck with `npm run acceptance -- --json`.

## Evidence index

- `command-m1-offline` — command, source `m1-offline`, SHA-256 `beea8f4c5ddf212547b0cca10702cbd807b2051cb8cf9d70e846ff6defb5d2ee`.
- `command-m4-agent-capability` — command, source `m4-agent-capability`, SHA-256 `66a053a638f2fc2aa0bb8f8cceb9bb3643c4ac2b18f28e4cceab948261ada0b2`.
- `command-m5-healing` — command, source `m5-healing`, SHA-256 `942ca33a672764016993b9c718b9cb7b54e280162d9f7e369bbab64d725fb561`.
- `command-m6-index-analysis` — command, source `m6-index-analysis`, SHA-256 `6da3ba8f2b072bb276b3d83c37f10817757c40b5bab0295a5358bbb1876975a7`.
- `db-m2-heartbeat-linked-collection-runs` — database-query, source `m2-heartbeat-linked-collection-runs`.
- `db-m3-latest-classification-coverage` — database-query, source `m3-latest-classification-coverage`.
- `db-m3-live-panel` — database-query, source `m3-live-panel`.
- `file-m1-fixture-inventory` — file, source `tests/fixtures`.
- `file-m3-active-strategy-validation-receipts` — file, source `data/validation`, SHA-256 `1bea70f30b7a0b71b7086791aa2b720b0d8959c3b5c5ad269fed5f23dff23f8e`.
- `file-m3-classification-human-review` — file, source `data/acceptance/evidence/classification-review-v1.json`.
- `file-m5-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `file-m6-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `file-m7-review-findings` — file, source `ops/review-findings.json`, SHA-256 `36a91770b3706258ea4d017f275e34f45f6bbd4e6aed86c325ceb316162f01a7`.
- `receipt-m0-fresh-clone` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `bec07e13c2a23d245b647c9fe40ce1a1005189dbc8ba2e2fd9bb8c594c48e376`.
- `receipt-m6-analysis-regenerate` — receipt, source `data/acceptance/evidence/fresh-clone.json`, SHA-256 `bec07e13c2a23d245b647c9fe40ce1a1005189dbc8ba2e2fd9bb8c594c48e376`.
- `service-m3-classification-automation` — service, source `precos-classification.service`.
- `service-m7-publication-operations` — service, source `m7-publication-and-six-timers`.

## Publication boundary

Publication audit: **FAIL**; findings: 6.

