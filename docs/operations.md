# Operations guide

## Setup and smoke

The single setup entry point installs or verifies the pinned Node 24/npm 11
runtime, Python 3.11+, SQLite, build tools, Playwright/Chromium dependencies,
and the `America/Sao_Paulo` system timezone on a Debian/Ubuntu host:

```bash
bash ops/setup.sh
bash ops/smoke.sh
```

Setup is idempotent, verifies the official Node archive checksum, uses locked
Node dependencies, installs the pinned Python
environment under ignored `var/analysis-venv/`, verifies Playwright Chromium,
creates private runtime directories, and migrates SQLite forward. It never
prints secrets. Set `INSTALL_TIMERS=1` only when intentionally deploying this
checkout.

Copy `.env.example` to `.env` only on the production host. Keep credential values
out of shell history and Git. The deterministic pipeline and M4 capability
acceptance work without model credentials. Classification may remain pending,
and live exploration remains unavailable until an operator supplies a
credential and explicit spend authorization.

`OPENAI_BASE_URL` may point at any OpenAI-compatible gateway and is used by
classification plus exploration when `CODEX_BASE_URL` is blank; a nonempty
`CODEX_BASE_URL` overrides it only for exploration. The API key is whatever
credential that gateway issues. Configure only models the gateway serves:
classification already uses `OPENAI_CLASSIFICATION_MODEL`, and exploration
uses `OPENAI_EXPLORER_MODEL`. Leaving both base URLs blank keeps the default
`api.openai.com` endpoint.

Once the configured gateway is running, an operator may load the private `.env`
and explicitly opt in to an explorer generation that exercises streaming and
tool calls. That is an optional provider experiment, not M4 delivery evidence.
The classification smoke remains useful when closing its independent coverage
gate:

```bash
set -a
. ./.env
set +a
LIVE_OPENAI=1 npm run test:live -- tests/explorer/codex-live.test.ts
LIVE_OPENAI=1 npm run test:live -- tests/classify/openai-live.test.ts
npm run acceptance -- --json
```

Do not export `LIVE_OPENAI` persistently. Without its per-command value of `1`,
the live tests remain skipped even when private credentials are configured;
the classification smoke also sets its provider retry limit to one.

## Local Control Room

The optional `apps/control-room/` application serves a Portuguese-first
operations dashboard on loopback only. Build and run it from the repository
root with the pinned Node 24/npm 11 runtime:

```bash
npm run control-room:build
npm run control-room:start
# http://127.0.0.1:4318
```

Observer mode is the default. It resolves `PROJECT_ROOT`/`DATABASE_PATH` through
the existing configuration, opens the file with `readonly=true`,
`fileMustExist=true`, and `PRAGMA query_only=ON`, and never migrates, changes
journal mode, reconciles interrupted work, or creates a missing primary
database. Every response is assembled from parameterized allowlisted queries;
retailer identities, dates, counts, models, and snapshot IDs are never compiled
into the frontend. An initialized empty fork renders an onboarding state and
populates automatically as its own SQLite database receives evidence.

Controls require a deliberate local opt-in:

```bash
npm run control-room:start -- --enable-actions
```

The browser cannot supply shell text, filesystem paths, environment values, API
keys, or signing material. The server exposes a fixed action catalog, invokes
`dist/cli.js` with `shell=false`, and removes schedule provenance variables from
manual child processes. Each execution requires a short-lived read-only preview,
a state fingerprint, exact confirmation phrase, lock recheck, and an exact USD
authorization for paid classification. Preview paths create no primary-database
write or process lock. Execution still acquires the CLI's authoritative lock and
uses the existing durable admission, budget, reconciliation, and validation
boundaries; the dashboard never updates `data/precos.sqlite` directly and never
auto-retries paid or network work.

Dashboard-local previews, jobs, status events, and sanitized receipts live under
ignored `var/control-room/control.sqlite` with private permissions. Raw stdout,
stderr, logs, URLs, replay paths, provider payloads, environment values, and
credentials are hashed/discarded rather than retained. Starting in observer mode
does not create that file when no prior history exists. The interface remains
optional: stopping it cannot interrupt collection or timers.

Useful verification commands:

```bash
npm run control-room:typecheck
npm run control-room:test
npm run control-room:test:e2e
```

## Scheduled services

`ops/install-systemd.sh` accepts only a completely clean committed worktree,
builds `dist` from that commit, and checks the tracked validator-bundle digest.
It then creates a new signed, read-only release under
`~/.local/share/precos/releases/<commit>-<release-id>` and enables six user
timers in `America/Sao_Paulo`:

- daily collection around 03:00;
- queued healing around 03:30;
- daily backup around 04:15;
- weekly discovery Sunday around 18:00, after the daily window, with lock-conflict retries;
- weekly index/analysis Monday around 08:00;
- hourly heartbeat check.

All timers are persistent and randomized. Every terminal daily collection outcome
starts the non-timer `precos-classification.service` through `OnSuccess` or
`OnFailure`; that oneshot runs incremental batches of 50 after any collection
evidence has already committed. A missing model credential remains a safe pending
exit, while a later classification failure cannot roll back or erase collection evidence. Collection,
classification, healing, and index work use separate locks. Never kill a live
owner or start duplicate daily work merely to improve acceptance metrics.

Every service uses the frozen release as its working directory, carries
`PRECOS_RELEASE_ID`, and verifies the complete Ed25519-signed artifact manifest
before execution against the original checkout's tracked public key (the copy
inside the release is never accepted as its own trust anchor). The release
contains the built runtime, retailer definitions,
operations scripts and units, package manifests, public verification material,
and analysis code. Its `data`, `var`, and `analysis/output` paths are explicit
links to the original checkout's state; `node_modules` is a declared dependency
link. The original checkout remains the source of `.env`, so credentials are
neither copied into nor hashed by a release. The private install receipt at
`var/operations/systemd-install.json` uses schema 2: `scheduleActivatedAt` is
preserved across redeployments, while `deployedAt`, commit, release ID/path,
signed-manifest hash, and installed unit set are refreshed and bound together.
Installation also enables and verifies user linger so timers survive logout.
A later committed collection/export cut does not invalidate that executable:
acceptance treats only `data/**`, `analysis/output/**`, and the strict generated
acceptance-receipt allowlist as release-neutral state. The release source and
evaluated commit must remain on one linear history, and their complete diff
must stay inside those state paths. Any retailer config, source, dependency,
unit, script, test, or other repository change makes the installed release
non-current and requires a new clean deployment.
A dry run creates no release; after the first deployment it deterministically
renders from the already installed, strictly validated release.

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
the request: discovery and collection share one hard 2,000-request
retailer/day cap. Redirects and every tier-4 browser/script exchange are charged
and politely paced at the transport boundary. Discovery references have a
separate 3,000/day admission and
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
heartbeats never satisfy schedule freshness or acceptance. A scheduled
heartbeat also binds the exact `precos-daily.service` cgroup, systemd
`INVOCATION_ID`, and current frozen release ID; merely exporting
`PRECOS_SCHEDULE_SOURCE` fails closed.

The missed-run drill never sacrifices production collection or inserts an old
heartbeat. It starts a uniquely named disposable user-systemd unit whose fixed
command self-terminates with `SIGKILL`, verifies `Result=signal`, status 9, the
systemd invocation ID, and invocation-matched journal records, then removes the
failed transient unit. It validates the installed signed frozen release and
runs that release's `dist/cli.js db init` and `heartbeat check --json` against a
temporary file-backed database with an isolated local alert file. The complete
production heartbeat view is hashed before and after and must be unchanged.

```bash
npm run acceptance:drill -- alert --confirm-safe-drill --json
```

## Optional installed-release live healing drill

M5 delivery acceptance is satisfied by the deterministic mutated-layout,
sabotage, healing, recovery, and worker/timer suites. Those tests exercise the
same trusted 30-reference activation boundary with controlled provider fixtures,
so a paid live-agent result is not mandatory evidence.

An operator may still run the stronger live staging experiment below. It
validates the currently installed signed frozen release, takes an online
file-backed copy of the production database while holding the pipeline and
explorer locks, and creates a disposable retailer only inside that copy. It
deliberately replaces the disposable API field selectors with invalid JSON
paths, observes a drift-classified failed run and queued healing event, then
uses the real Codex provider under a durable bounded budget reservation. Any
generated successor must pass the trusted host's exact 30-reference gate,
activate, and recover a second 30-product run at at least 90% success.

Because this is optional paid experimentation, the command refuses before
staging or provider work unless both the private credential and explicit spend
authorization are present:

```bash
LIVE_OPENAI=1 npm run acceptance:healing-drill -- \
  --confirm-staging-sabotage --authorize-live-spend-usd 25
```

When run, the signed public-safe receipt is
`data/acceptance/evidence/healing-sabotage-drill.json`. The file-backed staging
database, validation receipt, logs, and any replay material remain mode-`0600`
private evidence under `var/acceptance/m5-healing/<drill-id>/`; the copied
signing key is deleted before publication. The receipt documents the optional
experiment but is not required for M5 or overall delivery acceptance.

## Backup and restore-read drill

`ops/backup.sh` uses SQLite's online `.backup`, requires both integrity and
foreign-key checks to pass, and publishes the database and its mode-`0600`
receipt under ignored `var/backups/`. The receipt is written through a private
temporary file and atomic rename. It binds the exact artifact hash, coherent
snapshot fingerprint and per-table counts, schema migration state, completion
time, and (for the scheduled service) systemd `INVOCATION_ID`. Source facts are
captured in a pinned read transaction on the same connection used by SQLite's
online backup; the artifact is independently recomputed and publication fails
if the two snapshots differ. An invocation ID is classified as scheduled only
while the writer process is in the exact `precos-backup.service` cgroup recorded
by `/proc/self/cgroup`; copying an old ID into a manual shell is rejected.
Acceptance trusts
only the receipt whose invocation ID equals the recorded
`precos-backup.service` invocation; filename recency and modification-time
proximity are not evidence. The service refuses manual systemd starts; an
operator may run `bash ops/backup.sh` for a manual receipt, but that receipt
cannot satisfy the scheduled acceptance gate. Files older than 14 days are
rotated as bundles,
including `-wal`/`-shm` companions, and orphan SQLite sidecars are removed only
after the checkpoint handle is closed. When present, the mode-0600 Ed25519
validation private key is copied into the same private rotation; the tracked
public verifier is not a secret.

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
# Trust-minimized equivalent, bypassing npm as a parent process:
./ops/verify-fresh-clone.sh
```

The fresh-clone verifier must be executed directly, never as
`bash ops/verify-fresh-clone.sh`. Its executable interpreter boundary clears the
environment before Bash starts, then recovers only the current account's home
directory so the pinned Node 24 runtime remains discoverable. This prevents
`BASH_ENV`, inherited shell functions, aliases, runtime preloads, and caller
`PATH` entries from reaching the verifier's Bash process. The npm command is
safe under the normal npm `/bin/sh` launcher because it executes that boundary
directly. As with every child process, it cannot undo code already executed by
a compromised parent npm, interactive shell, or operating-system loader; use
the direct executable form to minimize that unavoidable parent-process trust
boundary.

A secret/history finding blocks publication. Revoke/rotate first; do not rewrite
history without author approval. Paid services, anti-blocking escalation,
publication beyond the charter, a panel below three retailers, and index-method
changes also require author authority. Deterministic collection continues when
nonessential model work is paused.
