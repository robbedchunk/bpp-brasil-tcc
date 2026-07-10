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
