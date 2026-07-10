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
