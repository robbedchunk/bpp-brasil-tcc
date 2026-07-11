# Operations decisions

## 2026-07-10 — M0 foundation

- The supported runtime is Node `>=24 <25` with npm `>=11 <12`; package install
  scripts are pinned explicitly for reproducible native builds.
- SQLite stores BRL prices as integer centavos and model costs as non-negative
  USD values. Foreign keys, WAL, a five-second busy timeout, and hand-written
  migrations are enabled at every database open. Migration checks and writes
  run inside one `IMMEDIATE` transaction so concurrent first startup cannot
  apply the same version twice.
- Evidence history rejects deletion in SQLite itself. Observations, failures,
  classifications, heartbeats, and costs also reject every update; strategy,
  run, exploration, and healing rows expose only explicit lifecycle and
  finalization fields for updates.
- Runtime directories use mode `0700` and the SQLite database uses mode `0600`.
  HTML replay evidence, logs, backups, local databases, and credentials are
  excluded from Git.
- Collection heartbeats become stale after 24 hours. `precos status` reads only
  SQLite and therefore cannot trigger collection, alerts, or any network call.
- Setup installs a Playwright Chromium browser only when absent and invokes the
  operating-system dependency installer only when `ldd` reports a missing
  shared library.
- User timer installation remains opt-in with `INSTALL_TIMERS=1`. M0 installs
  only an hourly `precos-status.timer`; its service runs the existing offline
  `status --json` command through rendered absolute Node, npm, and project paths.
  Later operations milestones may add collection timers without broadening this
  harmless foundation unit.

## 2026-07-10 — M2 retailer activation

- The publishable production database path is `data/precos.sqlite`; raw HTML is
  separate content-addressed gzip evidence beneath ignored `data/raw-html/`.
- Pão de Açúcar is active only for CEP `01310-100` with official GPA store `61`
  (ERP `0001`). Its bounded official search response was HTTP 200 and 30/30
  records contained an id, canonical URL, non-empty title, positive price, and
  boolean stock field.
- Extra Mercado is active only for the same CEP with official GPA store `923`
  (ERP `2426`). Its bounded official search response was HTTP 200 with the same
  30/30 field result. Both GPA collectors use the identifying research user
  agent, one-page discovery, 3–5 page concurrency, and a 750–1250 ms randomized
  start gate; no challenge bypass or proxy is used.
- The initial extraction v1 incorrectly reused search for individual numeric
  IDs and produced two preserved 0/30 HTTP-404 runs. Storefront code identified
  the official bounded `v4/products/ecom/{id}/bestPrices` route. Extraction v2
  then passed independent, sequentially paced 30/30 validation for each primary;
  v1 was retired through lifecycle fields and its evidence was not rewritten.
- Carrefour's official account-host catalog returned HTTP 206 with 30 product
  records, and checkout region lookup returned HTTP 200. It remains inactive:
  catalog offers used seller `1`, while CEP `01310100` mapped to regional seller
  `carrefourbrfood1935`; a store-aware 30-sample score is not yet defensible.
- St Marché's sitemap and Remix product state were reachable, but its product
  state did not establish a CEP/store identity. It remains inactive pending a
  restricted regional 30-sample gate. Saved Remix fixtures retain only product
  fields and remove public tokens, analytics identifiers, and unrelated state.
- Sonda remains the named inactive first backup. Its sitemap and Product JSON-LD
  were reachable, but availability/store evidence was incomplete. It will not
  replace a primary without three consecutive days of recorded blocking. Mambo
  was not added because no fallback swap is currently justified.
- Saved live fixtures contain provenance timestamps and no response headers,
  cookies, address details, session identifiers, or tokens. Every mutation is
  synthetic and labeled as such.

## 2026-07-10 — M2 production operations

- Daily collection runs around 03:00, weekly discovery on Sunday around 02:00,
  heartbeat checks hourly, and backups around 04:15, all in
  `America/Sao_Paulo` with persistent randomized user timers.
- All mutating CLI entry points share one atomic PID/start-time process lock.
  Live owners are never killed; orphaned locks are recovered by atomic rename.
- JSONL logs rotate on the São Paulo date and size, use mode `0600`, and
  recursively redact credentials, authorization/cookies, API keys, tokens, and
  `NTFY_TOPIC`. Alerts use validated ntfy topics only and otherwise append to a
  private local fallback.
- SQLite backups use the online `.backup` command, require an `ok` integrity
  check, use mode `0600`, and retain 14 days. Legacy `var/precos.sqlite` is
  copied only when the destination is absent; a populated legacy source never
  overwrites an existing production database.
- The budget guard pauses only nonessential model work above its configured
  monthly ceiling. Deterministic collection and other essential work continue.
- The production host logged inotify watch-capacity warnings while starting
  one-shot services, but both heartbeat and backup drills exited successfully;
  this host-level limit remains visible for operator follow-up.

## 2026-07-10 — M7 publication boundary

- Publication auditing scans the prospective Git tree and every blob reachable
  from local refs. Findings expose only rule IDs and safe locations; matched
  credential or private payload values are never printed or hashed into reports.
- Sanitized bounded HTML under `tests/fixtures/` remains public test evidence.
  Runtime raw HTML/replay archives, `.env`, profiles, logs, alerts, locks,
  backups, SQLite sidecars, and raw drill receipts remain ignored and private.
- The observation SQLite snapshot may retain nullable replay metadata columns,
  but public database/CSV auditing rejects raw bodies, credentials, personal
  data, absolute host paths, and tracked replay targets.
- Fresh-clone verification removes credential integrations, uses an isolated
  database and HOME, performs no live retailer/model/alert call, and proves the
  public analysis can be regenerated from committed CSV inputs.
- The author controls remote creation and publication. A history secret blocks
  publication and requires rotation plus explicit approval before destructive
  history rewriting.

## 2026-07-10 — M7 evidence-based acceptance

- The acceptance report derives M0–M7 from sanitized command receipts,
  prepared read-only SQLite queries, public file hashes, systemd state, and
  strict drill receipts. A failure dominates pending, and pending dominates
  pass; every passing criterion cites evidence.
- External time, credential, retailer-site, and author-authority gates remain
  `pending` with an explicit recheck command. Routine monitoring exits zero for
  honest pending evidence; strict completion exits three and never changes a
  date, inserts evidence, or calls a paid provider.
- The alert drill classifies an injected 25-hour age in memory and proves the
  live heartbeat identity is unchanged. The backup drill uses SQLite online
  backup and a second restore-read copy; neither drill replaces or edits the
  production database.
- Private detailed receipts, alert lines, and backup bytes stay under ignored
  `var/` paths with mode `0600`. Only primitive sanitized facts, hashes,
  repository-relative paths, and implementation commit identity are public.
- Acceptance evidence uses a two-commit protocol: receipts and reports name the
  clean implementation commit, while a later evidence-only commit may add only
  public receipts, the JSON snapshot, and its Markdown rendering.

## 2026-07-10 — M6 index method and public snapshots

- Index calculation is read-only with respect to SQLite. Derived rows are
  immutable, content-hashed filesystem snapshots, so weekly analysis cannot
  rewrite source evidence or hold a database read transaction during network or
  filesystem work.
- The method is fixed as promo price when positive, product carry-forward for at
  most seven calendar days, Jevons within retailer/sub-item, an equal arithmetic
  mean across retailers, and POF-weight aggregation renormalized over covered
  sub-items. Whole-panel missing days break the chain rather than implying zero
  movement.
- Retailer min/max sensitivity values are descriptive only and are never called
  confidence intervals or statistical validation. The experimental index remains
  a demonstration artifact.
- The official comparison is IBGE aggregate 7060, variable 63, classification
  315/category 7171, locality N7/3501. The official N7 São Paulo series and the
  retailer CEP panel have different geographic definitions; published figures
  must retain that caveat and never upsample monthly official values to daily.

## 2026-07-10 — M6 reproducible analysis and weekly publication

- Thesis figures and tables are generated only from a verified immutable CSV
  snapshot. The Python worker checks the export manifest schemas and SHA-256
  hashes before reading data; it never opens or mutates the evidence database.
- The fully pinned analysis environment lives under ignored
  `var/analysis-venv/` and is rebuilt whenever either the requirements digest or
  Python major/minor version changes.
- The weekly publication timer runs on Monday around 08:00
  `America/Sao_Paulo`, after the daily collection window, with a persistent
  randomized delay of up to 30 minutes. It preserves all five existing
  production timers.
- Success rates and healing counts are descriptive operational evidence.
  Retailer dispersion is likewise descriptive; no plot or table represents it
  as a confidence interval, statistical validation, or causal model result.

## 2026-07-10 — M6 review repair boundary

- Decimal values remain at 40-digit internal precision through product
  relatives, retailer Jevons means, subitem means, covered-weight aggregation,
  dispersion, and chaining. Twelve-decimal formatting occurs only at the
  published type boundary.
- A latest same-day unavailable or invalid observation is authoritative and
  cannot be replaced by an older carry. Coverage exclusions use one explicit
  reason per excluded classified product, including baseline/no-movement days.
- Publication now requires all 84 unique in-scope POF rows, four-decimal source
  weights summing exactly to `12.1181`, and one verified provenance digest.
  `--require-official` still publishes an honest `official_unavailable`
  snapshot before returning a failing result.
- SIDRA parsing detects duplicate raw month keys before ordinary JSON parsing
  and accepts only the exact `application/json` media type with optional
  parameters. Export output paths reject symlink components.
- Analysis pointers bind snapshot path, ID, and manifest digest. Existing
  outputs are byte/row/hash reverified before reuse, and manifests enumerate
  every consumed CSV. The weekly oneshot is ordered after both daily collection
  and weekly discovery services.

## 2026-07-10 — Static charter-gap remediation

- Collection uses a retailer-local blocking controller. Three consecutive hard
  failures (`403`, `429`, CAPTCHA, or domain denial) or three consecutive
  timeout/network failures stop new starts. Backoff begins at one second,
  doubles, and is capped at eight seconds. Any nonblocking outcome resets the
  sequence because parse/missing/invalid-price evidence is drift, not access
  blocking. In particular, an already-running success received after two fast
  hard failures resets the sequence before the third-failure stop threshold.
- The concurrency pool remains between three and five. Work already in flight
  finishes and persists; only actual attempts affect run counters and failure
  rows. Summaries expose planned, attempted, skipped, and blocking-stop facts.
- Browser contexts retain the identifying academic user agent and all existing
  network controls. The only stealth profile is the charter-authorized minimum:
  Chromium's `AutomationControlled` signal is disabled, locale/timezone/viewport
  are stable for São Paulo, and a trusted init script normalizes
  `navigator.webdriver`. No proxy, challenge bypass, or broad fingerprint
  emulation was added.
- Incremental synchronous classification is a separate oneshot started by the
  daily service's `OnSuccess`. It runs batches of 50 at append-only version 1,
  adds no seventh timer, remains exit-zero/pending without a key, and cannot roll
  back the heartbeat already committed by daily collection.
