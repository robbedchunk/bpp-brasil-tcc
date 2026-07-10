# Tasks 7–9 integrated report

Date: 2026-07-10 (America/Sao_Paulo)  
Branch: `feat/full-charter`

## Outcome

M2 is operational on the production box. Pão de Açúcar (CEP 01310-100,
store 61) and Extra Mercado (CEP 01310-100, store 923) are the only active
retailers. Both have completed discovery and collection evidence. Carrefour,
St Marché, and Sonda remain honestly inactive for the regional/field reasons
below. Four production user timers are installed, enabled, and waiting.

The production database is `data/precos.sqlite`. The legacy
`var/precos.sqlite` contained schema only (zero retailers, strategies,
products, runs, observations, and failures), was not deleted, and no data was
lost. Setup copies a legacy database only when the destination is absent and
refuses to overwrite an existing destination when legacy evidence exists.

## TDD evidence (RED → GREEN)

### Task 7 pipeline

- RED: `npm test -- tests/pipeline` failed three suites with missing
  `src/pipeline/{discover,collect,daily}.ts`.
- RED: pipeline CLI/default-path tests failed three assertions because commands
  were absent and the default was still `var/precos.sqlite`.
- GREEN: the first focused pipeline/CLI/database pass was 26/26.
- Additional RED regressions observed before fixes:
  - replay directory `ENOTDIR` escaped and left a running row;
  - prior same-day attempt count 1,999 still allowed 10 more requests;
  - iterator cleanup failure changed a one-page run to attempted=2;
  - failure-evidence storage error double-counted a discovery attempt;
  - sequential worker test saw zero observations before the next product;
  - HTML results were initially materialized before persistence.
- GREEN: runs finalize in `finally`; same-day persisted attempts cap at 2,000;
  CLI mutations share an orphan-recovering process lock; collection persists
  each non-candidate result transactionally and keeps only a bounded online
  20-entry reservoir of eligible HTML bodies. Final pipeline suite: 15/15.

### Task 8 live retailers

- RED: `npm test -- tests/retailers` failed with missing retailer config module.
- RED: offline extraction initially failed for Carrefour and St Marché fixtures.
- RED: immutable same-version strategy mutation was silently ignored, retired
  strategies could be reactivated, and one validation object was copied to
  both purposes.
- GREEN: retailer suite is 8/8. Discovery and extraction now have separate
  provenance/30-sample gates; same-version immutable differences fail closed;
  retired versions require successors; strategy/config domains match both
  directions; inactive retailers deactivate every strategy version.
- Saved fixtures contain provenance/date, omit headers/cookies/addresses/tokens,
  and label mutations synthetic. St Marché's explicit `sale-list` price order
  maps list price to regular and sale price to promo without violating the
  observation constraint.

### Task 9 operations

- RED: `npm test -- tests/ops` failed five suites with missing logger, alerts,
  lock, heartbeat, and budget modules.
- RED: heartbeat CLI was unknown; schedule/backup tests exited 127; systemd
  dry-run wrote the default unit directory; stale locks were unrecoverable;
  logger filenames used the UTC day and did not redact `NTFY_TOPIC`.
- GREEN: focused pipeline/retailer/ops/CLI package is 49/49. Full verification:
  `npm run typecheck && npm test` passed 31 files and **165/165 tests** under
  Node v24.18.0.

## Live evidence (minimal official requests)

No proxy, bypass, CAPTCHA escalation, broad `/busca` crawl, or secret-bearing
request was used. Requests used the identifying academic research user agent.

| Retailer / evidence URL | HTTP / result | Decision |
|---|---:|---|
| Pão delivery: `https://api.vendas.gpa.digital/pa/delivery-v2/ecom/deliveryOptions?zipCode=01310100` | 200; store 61 / ERP 0001 covered | active candidate |
| Pão search: `https://api.vendas.gpa.digital/pa/search/search` | 200; 30/30 discovery records | discovery v1 active |
| Pão `.../pa/v4/products/ecom/{id}/bestPrices?storeId=61&isClienteMais=true` | 30/30 paced validation | extraction v2 active |
| Extra delivery: `https://api.vendas.gpa.digital/ex/delivery-v2/ecom/deliveryOptions?zipCode=01310100` | 200; store 923 / ERP 2426 covered | active candidate |
| Extra search: `https://api.vendas.gpa.digital/ex/search/search` | 200; 30/30 discovery records | discovery v1 active |
| Extra `.../ex/v4/products/ecom/{id}/bestPrices?storeId=923&isClienteMais=true` | 30/30 paced validation | extraction v2 active |
| Carrefour official account catalog `.../api/catalog_system/pub/products/search?ft=arroz&_from=0&_to=29` | 206; 30 records | inactive |
| Carrefour checkout `.../api/checkout/pub/regions?country=BRA&postalCode=01310100&sc=2` | 200; regional seller `carrefourbrfood1935` differed from catalog seller `1` | inactive pending regional 30-sample proof |
| `https://www.marche.com.br/sitemap.xml` and one product page | 200 / 200; Remix fields valid, no CEP/store identity | inactive |
| `https://www.sondadelivery.com.br/sitemap.xml` and one product page | 200 / 200; JSON-LD omitted availability/store proof | inactive named backup |

The first GPA extraction v1 incorrectly reused search for numeric IDs. Its two
live runs are preserved at 0/30 with sixty HTTP-404 failures. Storefront code
identified the bounded official `bestPrices` route. Append-only extraction v2
then passed independent paced 30/30 validation per retailer and completed
persisted 30/30 runs. V1 lifecycle validation fields were corrected to 0/30;
its immutable creation provenance and failed runs remain intact.

## Database/run evidence

Evidence query:

```sql
SELECT retailer_id,stage,strategy_version,status,attempted,ok,failed
FROM runs ORDER BY started_at;
```

Result summary:

```text
extra-mercado discover v1 completed 30/30
pao-de-acucar discover v1 completed 30/30
extra-mercado collect  v1 failed     0/30 (30 HTTP 404)
pao-de-acucar collect  v1 failed     0/30 (30 HTTP 404)
extra-mercado collect  v2 completed 30/30
pao-de-acucar collect  v2 completed 30/30
extra-mercado collect  v2 completed  1/1  (daily ops drill)
pao-de-acucar collect  v2 completed  1/1  (daily ops drill)
```

Current counts: 5 retailers, 17 immutable strategy rows, 60 products, 8 runs,
62 observations, 60 preserved failures, 1 completed heartbeat, and 0 cost/LLM
ledger rows. `PRAGMA integrity_check` returns `ok`. No HTML is stored in SQLite.
Live GPA strategies are JSON APIs, so the live run produced no HTML candidates;
the deterministic replay test retains exactly 20 of 100 eligible HTML bodies as
SHA-256 `.html.gz` files at mode 0600.

Dry-run drill (`daily --limit 1 --dry-run --json`) returned 2/2 valid probes and
left runs/observations/heartbeats unchanged at 6/60/0. The bounded actual drill
then returned 2/2, raised observations to 62, and wrote the completed all-active
retailer heartbeat. `heartbeat check --json` reported fresh. No LLM call or cost
row was made.

## Operations and timers

- `bash ops/setup.sh`: ready; production path initialized safely.
- `bash ops/backup.sh --self-test`: `backup: self-test ok`.
- Live backup used SQLite `.backup`, returned integrity `ok`, mode 0600, and
  contained all 62 observations.
- `bash ops/install-systemd.sh --dry-run`: rendered all four timers without
  touching the default user unit directory.
- Actual install rebuilt `dist`, disabled the temporary status timer, and
  enabled/started:
  - `precos-daily.timer` — next daily event around 03:00 São Paulo;
  - `precos-weekly-discovery.timer` — Sunday around 02:00;
  - `precos-heartbeat.timer` — hourly at approximately minute 15;
  - `precos-backup.timer` — daily around 04:15.
- `systemctl --user` reports all four `enabled` and `active (waiting)`.
  Manual heartbeat and backup services both returned `Result=success`,
  `ExecMainStatus=0`.

## Commits

- `44a9a39` — `feat(m2): orchestrate discovery and collection runs`
- `7d4bb1b` — `feat(m2): activate initial retailer strategies`
- `adc2781` — `feat(ops): schedule and safeguard daily collection`

## Self-review and remaining gates

Self-review resolved: finally-based run lifecycle, online bounded HTML reservoir,
cumulative cap, global CLI lock, orphan recovery, dry-run unit isolation,
per-purpose live validation, immutable version fail-closed behavior, retired
version protection, bidirectional domain checks, São Paulo log rotation,
`NTFY_TOPIC` redaction, and St Marché price-order semantics.

Pending time-gated authority boundaries:

- Carrefour needs an honest regional/store-aware 30-sample extraction score.
- St Marché needs a restricted CEP/store-aware 30-sample score.
- Sonda cannot replace a primary without three consecutive recorded blocked
  days; Mambo was not needed or added.
- Natural daily, weekly, heartbeat, 14-day backup-retention, and three-day
  fallback behavior require elapsed wall-clock evidence; the timers are enabled
  to collect it.
- The host emitted `inotify` watch-capacity (`ENOSPC`) warnings when starting
  one-shot services. Both services succeeded; changing the host kernel limit is
  outside this task's authority and remains an operator concern.
