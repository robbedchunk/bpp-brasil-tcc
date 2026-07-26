# BPP Brasil TCC research pilot

This repository is a **research pilot under active development** for the
bachelor's thesis *Extração e Estruturação de Dados de Preços Online com
Modelos de Linguagem: Proposta de Índice Complementar ao IPCA*.

The defended claim is the guarded self-healing extraction **method**: the system
can call a language-model agent to propose typed extraction strategies, but no
proposal can enter deterministic daily collection without independent trusted
validation. Delivery acceptance proves that provider mechanism, the common
strategy-acceptance boundary, and automatic healing with deterministic
adversarial tests. It does **not** require or claim that a live model generated
the current production strategy set. The daily food-at-home index is a
demonstration artifact and makes **no statistical validation claim**.

## What it does

`precos` is a TypeScript/Node CLI backed by one SQLite database. It discovers
São Paulo supermarket products, collects price observations, classifies products
to IPCA food-at-home sub-items, detects extraction drift, generates replacement
strategies outside the collection hot path, and publishes reproducible CSV and
analysis snapshots. Strategy tiers progress from HTTP APIs and embedded JSON to
declarative DOM extraction and a restricted operation interpreter.

Every activation requires trusted validation on a preselected set of exactly 30
authoritative references with a score of at least 0.9. The host signs the
body-free receipt with Ed25519; configured, generated, and healed strategies all
pass the same immutable database activation gate. Runs, failures, strategy
versions, classifications, exploration attempts, costs, healing events, and
heartbeats remain evidence.

## Current evidence

The repository does not hard-code a success claim that can become stale. Run:

```bash
npm run acceptance -- --json
```

The command reports `pass`, `pending`, or `fail` for M0–M7 and preserves honest
time-, credential-, site-, and authority-gated criteria. See the generated
[acceptance report](docs/acceptance-report.md) for the current evidence snapshot.
The currently published research snapshot may legitimately say `no_index_data`
or `no_overlap`; those states never become invented prices or official values.

M4 is a capability and safety-boundary check, not a live-generation provenance
check. Its offline suite exercises the real Codex SDK adapter contract,
restricted disposable workspace, structured-output parsing, budget accounting,
trusted host validation, and atomic activation path with deterministic provider
fixtures. M3 independently requires signed 30-reference receipts for every
active strategy, and M5 exercises sabotage and automatic recovery. Paid live
exploration remains an optional operator-controlled experiment.

## Requirements

- Node `>=24 <25`
- npm `>=11 <12`
- Python `>=3.11` (the production host uses Python 3.14)
- SQLite 3 and Playwright Chromium system dependencies
- Linux with user systemd for production schedules

All Node and Python package versions are pinned. Offline setup, tests, audit, and
analysis require no OpenAI/Codex credential.

## Quick start

After the author makes the cited remote public:

```bash
git clone https://github.com/robbedchunk/bpp-brasil-tcc.git
cd bpp-brasil-tcc
bash ops/setup.sh
bash ops/smoke.sh
npm run analysis
```

`ops/setup.sh` installs locked dependencies, prepares the ignored Python virtual
environment, verifies Chromium, and initializes SQLite. It does not enable
production timers unless `INSTALL_TIMERS=1` is explicitly set.

[SETUP.md](SETUP.md) is the fresh-clone orientation brief — context, the
offline/outward boundary, and non-Debian notes — written to be handed directly
to a coding agent.

## Main commands

```bash
npm run precos -- status --json
npm run precos -- discover --json
npm run precos -- collect --json
npm run precos -- daily --json
npm run precos -- replay-reextract --observation <observation-id> --json
npm run precos -- classify --dry-run --json
npm run precos -- index --export --json
npm run research:snapshot
npm run analysis
npm run audit:publication -- --json
npm run acceptance -- --json
npm run acceptance -- --json --require-complete
```

## Local operations Control Room

`apps/control-room/` is an optional local-first React/Fastify operations console.
It reads the configured SQLite database through a literal read-only connection,
enumerates the fork's own retailers/runs/evidence at runtime, and never uses
hard-coded dashboard rows, test fixtures, snapshot CSVs, or generated PNGs as
live application data.

```bash
npm run control-room:build
npm run control-room:start
# open http://127.0.0.1:4318
```

The default is observer mode. Guarded CLI-backed controls require an explicit
local opt-in:

```bash
npm run control-room:start -- --enable-actions
```

Every action requires a fresh read-only preview, an exact confirmation phrase,
and (for model work) the exact previewed spend authorization. The CLI's locks,
admission ledgers, budget reservations, reconciliation, and strategy-validation
boundaries remain authoritative. The dashboard never accepts arbitrary commands
or writes directly to `data/precos.sqlite`.

Strategy receipt/key operations are documented in
[trusted strategy validation](docs/strategy-validation.md). A fresh clone can
verify receipts with the tracked public key; only the production host retains
the private signer.

Routine acceptance exits successfully for an honest `pending` report, while
`--require-complete` exits `3` until every external gate matures. Neither mode
changes the database or invokes a paid provider.

Live discovery/collection targets retailer sites and must follow the configured
caps, domain allowlists, robots policy, and off-peak schedule. Model-backed
classification/exploration additionally require an operator-provided credential
and explicit spend decision. Acceptance never makes a paid call.

## Published and private material

Published material includes source code, sanitized fixtures, retailer configs,
typed strategy versions/prompts, the observation SQLite snapshot, stable CSV
snapshots, analysis outputs, and sanitized acceptance receipts.

**Raw HTML is never published.** Credentials, `.env`, raw response/replay
archives, browser profiles, logs, alerts, locks, and backups are excluded from
publication and scanned out of the reachable Git history. See the
[data dictionary](docs/data-dictionary.md), [operations guide](docs/operations.md),
and [security policy](SECURITY.md).

## Ethics and limitations

Collection is throttled, bounded to retailer domains, scheduled off-peak, and
robots-aware for discovery. The project collects factual product/price data and
no personal data. It does not use proxies, CAPTCHA bypass, credential theft, or
countermeasure escalation. Retailer terms and site behavior can change; gaps,
blocking, unavailable providers, and degraded periods remain explicit.

See [ethics and ToS](docs/ethics-and-tos.md) and
[methodology](docs/methodology.md).

### Out of scope

- regions or CEPs outside the São Paulo pilot;
- other IPCA groups, marketplaces, and price aggregators;
- hosted, LAN-exposed, authenticated, or multi-user control planes; queues or Redis;
- hedonic/quality adjustment and statistical validation;
- paid proxies or anti-bot escalation without author approval;
- community-maintenance ceremony before the thesis defense.

## Development process

The pilot was implemented with coding-agent assistance (Claude), applied under
the same discipline the thesis studies: agent-produced changes entered the tree
only through the deterministic gates — typecheck, the offline suites, the
acceptance harness, and the publication audit. Agent-assisted commits carry
`Co-Authored-By` trailers in the Git history. The curated design specification
is preserved at
[docs/superpowers/specs](docs/superpowers/specs/2026-07-10-self-healing-extraction-design.md);
internal task-report scaffolding is not part of the published artifact. This
development tooling is unrelated to the system's runtime agent (the Codex SDK
explorer), which remains governed by the trusted validation gate.

## Sources and citation

The weight source, fixed SIDRA selection, and literature references are recorded
in [docs/sources.md](docs/sources.md). Repository citation:

> RobbedChunk (2026). *BPP Brasil TCC: self-healing online price extraction
> research pilot*. https://github.com/robbedchunk/bpp-brasil-tcc

This repository is licensed under the [MIT License](LICENSE). The author controls
when the local repository is pushed or made public.

An archival deposit with a citable DOI (Zenodo) is planned at publication; the
citation above gains the DOI once minted.
