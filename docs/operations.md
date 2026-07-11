# Operations guide

## Setup and smoke

Use Node 24/npm 11 and Python 3.11 or newer:

```bash
bash ops/setup.sh
bash ops/smoke.sh
```

Setup is idempotent, uses locked Node dependencies, installs the pinned Python
environment under ignored `var/analysis-venv/`, verifies Playwright Chromium,
creates private runtime directories, and migrates SQLite forward. It never
prints secrets. Set `INSTALL_TIMERS=1` only when intentionally deploying this
checkout.

Copy `.env.example` to `.env` only on the production host. Keep credential values
out of shell history and Git. The deterministic pipeline works without model
credentials; classification/exploration remain pending.

## Scheduled services

`ops/install-systemd.sh` renders absolute Node/Bash/project paths and enables six
user timers in `America/Sao_Paulo`:

- daily collection around 03:00;
- queued healing around 03:30;
- daily backup around 04:15;
- weekly discovery Sunday around 02:00;
- weekly index/analysis Monday around 08:00;
- hourly heartbeat check.

All timers are persistent and randomized. A successful daily collection service
starts the non-timer `precos-classification.service` through `OnSuccess`; that
oneshot runs incremental batches of 50 after the collection heartbeat has already
committed. A missing model credential remains a safe pending exit, while a later
classification failure cannot roll back or erase collection evidence. Collection,
classification, healing, and index work use separate locks. Never kill a live
owner or start duplicate daily work merely to improve acceptance metrics.

```bash
bash ops/install-systemd.sh --dry-run
systemctl --user list-timers --all 'precos-*' --no-pager
npm run precos -- status --json
```

Collection treats HTTP 403/429, CAPTCHA, and denied-domain results as hard
blocking evidence in one retailer-local access streak. Timeout/network evidence
must repeat before joining that same streak, so alternating hard and transport
categories cannot evade the stop; any responding extraction result or success
resets it. Before the threshold, starts use exponential delays beginning at one
second, with an eight-second cap. The serialized admission gate rechecks both an
extended deadline and blocking state after every wait. Requests already executing
finish; work only queued for polite spacing is not attempted after a stop.
Unstarted products are reported as skipped, not inserted as synthetic failures.
Every network start is charged through an append-only SQLite admission before
the request: discovery and collection each have an independent 2,000-request
retailer/day cap. Discovery references have a separate 3,000/day admission and
private replay writes a 20/day admission. Charges survive crashes by design and
remain atomic across concurrent processes; a terminal run cannot consume more.

## Logs, alerts, and health

JSONL logs and local fallback alerts live under ignored `var/log/` with private
permissions and recursive redaction. A valid `NTFY_TOPIC` sends to ntfy; missing,
invalid, or failed ntfy delivery falls back locally. Alert conditions include a
stale collection heartbeat, blocking/degradation, healing failure, pending
classification/provider work, and budget breach.

Collection finalization atomically records coherent `planned`, `skipped`, and
`stoppedForBlocking` metadata with the run counters. The monitor treats that stop
fact as blocking even when aggregate extraction success is at least 70%, alerts,
and spends no healing-model budget. The fact remains true when the threshold is
reached on the final planned product (`skipped = 0`) so access evidence is not
hidden by the success-rate shortcut.

The hourly checker alerts when no successful collection heartbeat exists or the
latest is older than 24 hours. Missing collection days remain gaps.
Retailer-level orchestration errors do not prevent later retailers from being
attempted. They and post-collection monitor errors produce a durable partial
heartbeat, a fallback-capable alert, and a nonzero daily service result; partial
heartbeats never satisfy schedule freshness or acceptance.

Task 16's missed-run drill does not kill a service or insert an old row. It calls
the pure heartbeat classifier with an injected 25-hour age, sends a `[DRILL]`
event through the configured sink, verifies delivery, and proves production
heartbeat rows are unchanged.

```bash
npm run acceptance:drill -- alert --confirm-safe-drill --json
```

## Backup and restore-read drill

`ops/backup.sh` uses SQLite's online `.backup`, requires `integrity_check=ok`,
sets mode `0600`, and rotates files older than 14 days under ignored
`var/backups/`. When present, the mode-0600 Ed25519 validation private key is
copied into the same private rotation; the tracked public verifier is not a
secret.

```bash
bash ops/backup.sh --self-test
npm run acceptance:drill -- backup --confirm-safe-drill --json
```

Verified private replay can be re-extracted after a normalization bug without
republishing the response body:

```bash
npm run precos -- replay-reextract --observation <observation-id> --json
```

The command shares the global mutation lock with scheduled collection and
persists only an immutable structured audit row in `replay_reextractions`.

The acceptance drill creates an online copy, checks integrity/foreign keys,
opens a second temporary restore-read copy, and compares migrations and critical
table counts. It never replaces, renames over, vacuums, attaches for writing, or
otherwise mutates `data/precos.sqlite`. Retention deletion is tested only in a
disposable directory.

## Publication and incident checks

```bash
npm run audit:publication -- --json
npm run acceptance -- --json
npm run verify:fresh-clone
```

A secret/history finding blocks publication. Revoke/rotate first; do not rewrite
history without author approval. Paid services, anti-blocking escalation,
publication beyond the charter, a panel below three retailers, and index-method
changes also require author authority. Deterministic collection continues when
nonessential model work is paused.
