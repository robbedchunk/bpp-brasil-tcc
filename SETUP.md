# Setup — orientation for a fresh clone

This file is the entry point after `git clone`, written for a coding agent as
much as for the human driving one. It explains what this repository is, what a
clone can honestly do, and where the boundaries are. It is a map, not a
script: the commands here are entry points, the ops scripts are short and
readable, and the code and docs are the authority when details matter.

## What you are looking at

`precos` is the research pilot behind the bachelor's thesis *Extração e
Estruturação de Dados de Preços Online com Modelos de Linguagem: Proposta de
Índice Complementar ao IPCA* — a TypeScript/Node CLI around one SQLite
database that discovers São Paulo supermarket products, collects price
observations, classifies them to IPCA food-at-home sub-items, and publishes a
small demonstration index with reproducible CSV and analysis snapshots.

The thesis claim lives in how the system heals, not in the scrapers
themselves. Extraction strategies are typed, versioned database rows (HTTP
APIs → embedded JSON → declarative DOM extraction → a restricted operation
interpreter). When a retailer site drifts, a language-model agent may
*propose* a replacement strategy, but no proposal — configured, generated, or
healed — activates without passing the same gate: validation against 30
preselected authoritative references with a score of at least 0.9, recorded
as an Ed25519-signed receipt. The load-bearing code is the boundary around
the model: admission, validation, budgets, and evidence. Start there if you
want to understand the project rather than just run it.

Treat the checkout as a laboratory, not a scaffold. It ships the real
observation database (`data/precos.sqlite`), the signed validation receipts
(`data/validation/`), stable CSV exports (`data/exports/`), and published
analysis snapshots (`analysis/output/`). There is real collected data to
explore before anything runs.

## The one split that matters

Everything needed to set up, test, audit, and explore the evidence works
offline with no credentials. Exactly two paths reach outward, and both are
opt-in:

- **Live collection** (`discover`, `collect`, `daily`) makes real requests to
  retailer sites. It is robots-aware for discovery, domain-allowlisted,
  capped, and scheduled off-peak on the production host. Running it from a
  clone is an operator decision to make deliberately, not a smoke test.
- **Model-backed work** (classification, strategy exploration/healing) needs a
  credential in `.env` plus an explicit spend decision, with a monthly budget
  cap enforced in the database. Setup, tests, analysis, and acceptance never
  make a paid call.

For evaluating the project, the offline surface is the whole demonstration.
If a task does not require retailer traffic or model spend, it belongs on the
offline side.

A clone also *verifies* evidence rather than minting it: signed receipts check
out against the tracked public key (`ops/validation-attestation-public.pem`),
while the private signer stays on the production host. Setup will report that
receipts are "verification-only" — that is the intended state everywhere
except the author's machine.

## Bringing it up

On Debian/Ubuntu Linux (including WSL2), the paved path is two commands:

```bash
bash ops/setup.sh
bash ops/smoke.sh
```

`ops/setup.sh` is idempotent and owns the whole environment: it installs
missing base packages through non-interactive `sudo apt-get`, downloads the
pinned Node 24 / npm 11 runtime (checksum-verified, under
`~/.local/share/precos/`) unless a matching one is already on `PATH`, installs
locked npm dependencies and the Python analysis venv (`var/analysis-venv/`),
verifies Playwright Chromium, then initializes/migrates the database and seeds
the retailer catalog if it is empty. Two behaviors are worth flagging to a
human before running it on a personal machine: it will set the **system
timezone** to `America/Sao_Paulo` if it differs, and `sudo -n` means it fails
fast rather than prompting when passwordless sudo is unavailable — in that
case run the apt/timezone parts yourself and re-run the script.

`ops/smoke.sh` typechecks, runs the full test suite, audits the publication
rules, and prints a status report. No `.env` is needed for any of this —
every setting has a working default. Copy `.env.example` to `.env` only when
configuring the outward-facing paths above.

**On macOS or any host without `apt`:** treat `ops/setup.sh` as the
specification rather than the script. The contract is Node `>=24 <25`, npm
`>=11 <12`, Python `>=3.11` with `venv`, `sqlite3`, `xz`, and Playwright
Chromium; satisfy it with the machine's own package manager (the ops scripts
also find Node 24 under `~/.nvm`), then run the project-level steps from the
second half of the script (`npm ci`, `ops/setup-analysis.sh`, Chromium,
`db init`, retailer seeding — all portable). Prefer exporting
`TZ=America/Sao_Paulo` for runs over changing the machine's timezone; the
project's own fresh-clone verifier does the same.

**On Windows:** WSL2 with Ubuntu is the supported route and joins the paved
path above. Native Windows is unverified — the npm/TypeScript core is
cross-platform in principle, but the `ops/` layer assumes POSIX. Attempts are
welcome as experiments, with expectations set accordingly.

One flag to know about: `INSTALL_TIMERS=1 bash ops/setup.sh` installs the
production systemd timers. Leave it unset on any machine that is not meant to
run the pilot on a schedule.

One clone-time expectation: `data/precos.sqlite` ships through Git LFS
(~290 MB) and downloads during checkout. If a fresh clone stalls or errors on
that single file, the LFS bandwidth quota is the likely cause rather than
anything in the repository itself.

## Exploring

Pick whatever answers the current question; nothing here changes data or
spends money.

- `npm run precos -- status --json` — retailers, strategy versions, recent
  runs, heartbeat freshness. The CLI is Commander-based; `--help` enumerates
  the rest.
- `npm run acceptance -- --json` — the evidence report for milestones M0–M7.
- `npm run control-room:build && npm run control-room:start` — a local
  read-only operations console at `http://127.0.0.1:4318`: runs, strategies,
  healing events, and costs, browsable by a human. Observer mode is the
  default; guarded CLI-backed actions exist only behind `--enable-actions`
  with previews and explicit confirmation phrases.
- `npm run analysis` — regenerates the index, coverage, and healing figures
  from the tracked exports into `analysis/output/`.
- `sqlite3 'file:data/precos.sqlite?mode=ro'` — the schema is
  `src/db/schema.sql`; runs, observations, strategies, healing events, costs,
  and heartbeats are ordinary tables designed to be read.
- `npm test` — the full suite is deterministic and offline; live-site and
  model behavior is exercised through fixtures.

Read reported states at face value. `pending` in the acceptance report marks
criteria that are time-, credential-, site-, or authority-gated: an honest
`pending` is a successful run, and `--require-complete` exiting `3` is that
honesty enforced, not a defect to fix. Likewise the published index snapshot
may say `no_index_data` or `no_overlap` — absent data stays absent instead of
becoming an invented number.

## Map

| Path | What it is |
| --- | --- |
| `src/` | CLI and pipeline: `discovery/`, `collection/`, `classify/`, `strategies/`, `explorer/` (model-agent sandbox), `healing/`, `index/`, `db/` |
| `ops/` | setup and smoke, acceptance harness, systemd units, attestation public key |
| `data/` | tracked evidence: SQLite snapshot, CSV exports, validation receipts, IPCA reference weights |
| `var/`, `dist/` | ignored runtime state and build output, recreated locally |
| `apps/control-room/` | the read-only console (React/Fastify workspace) |
| `analysis/` | Python figure generation and published snapshots |
| `retailers/`, `scripts/`, `tests/` | retailer configs, maintenance scripts, vitest suites |

## Where the depth is

[docs/methodology.md](docs/methodology.md) — what is measured and why;
[docs/strategy-validation.md](docs/strategy-validation.md) — the trust
boundary and receipts; [docs/data-dictionary.md](docs/data-dictionary.md) —
every table and export column; [docs/operations.md](docs/operations.md) —
day-2 operations on the production host;
[docs/acceptance-report.md](docs/acceptance-report.md) — the generated
evidence snapshot; [docs/ethics-and-tos.md](docs/ethics-and-tos.md) and
[docs/sources.md](docs/sources.md) — collection ethics, weights, and
citations. The [README](README.md) states the defended claim and its scope;
[SECURITY.md](SECURITY.md) states the publication rules.
