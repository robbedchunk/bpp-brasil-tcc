# BPP Brasil TCC research pilot

This repository is a **research pilot under active development** for the
bachelor's thesis *Extração e Estruturação de Dados de Preços Online com
Modelos de Linguagem: Proposta de Índice Complementar ao IPCA*.

The defended claim is the self-healing extraction **method**: a language model
can generate and repair typed, externally validated extraction strategies while
daily price collection remains deterministic. The daily food-at-home index is a
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
- dashboards, queues, Redis, or a web service;
- hedonic/quality adjustment and statistical validation;
- paid proxies or anti-bot escalation without author approval;
- community-maintenance ceremony before the thesis defense.

## Sources and citation

The weight source, fixed SIDRA selection, and literature references are recorded
in [docs/sources.md](docs/sources.md). Repository citation:

> RobbedChunk (2026). *BPP Brasil TCC: self-healing online price extraction
> research pilot*. https://github.com/robbedchunk/bpp-brasil-tcc

This repository is licensed under the [MIT License](LICENSE). The author controls
when the local repository is pushed or made public.

TODO: register on `zenodo`.
