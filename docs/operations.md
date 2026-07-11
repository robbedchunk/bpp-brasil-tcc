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

All timers are persistent and randomized. Collection, healing, and index work
use separate locks. Never kill a live owner or start duplicate daily work merely
to improve acceptance metrics.

```bash
bash ops/install-systemd.sh --dry-run
systemctl --user list-timers --all 'precos-*' --no-pager
npm run precos -- status --json
```

## Logs, alerts, and health

JSONL logs and local fallback alerts live under ignored `var/log/` with private
permissions and recursive redaction. A valid `NTFY_TOPIC` sends to ntfy; missing,
invalid, or failed ntfy delivery falls back locally. Alert conditions include a
stale collection heartbeat, blocking/degradation, healing failure, pending
classification/provider work, and budget breach.

The hourly checker alerts when no successful collection heartbeat exists or the
latest is older than 24 hours. Missing collection days remain gaps.

Task 16's missed-run drill does not kill a service or insert an old row. It calls
the pure heartbeat classifier with an injected 25-hour age, sends a `[DRILL]`
event through the configured sink, verifies delivery, and proves production
heartbeat rows are unchanged.

## Backup and restore-read drill

`ops/backup.sh` uses SQLite's online `.backup`, requires `integrity_check=ok`,
sets mode `0600`, and rotates files older than 14 days under ignored
`var/backups/`.

```bash
bash ops/backup.sh --self-test
npm run acceptance:drill -- backup --confirm-safe-drill --json
```

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
