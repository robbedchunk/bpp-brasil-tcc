# LLM-Generated Self-Healing Extraction Strategies — TCC Pilot

**Status:** Approved
**Date:** 2026-07-10
**Source of truth:** The execution charter supplied by the thesis author on
2026-07-10. This document records that charter as an implementation design.

## 1. Purpose and evidence

The pilot supports the bachelor's thesis *Extração e Estruturação de Dados de
Preços Online com Modelos de Linguagem: Proposta de Índice Complementar ao
IPCA*. Its defended claim is that a language model can generate and repair
deterministic online-price extraction strategies, reducing the manual
maintenance cost of Billion Prices Project-style collection.

The system therefore treats operational evidence as a first-class output:

- extraction success rate by retailer and day;
- layout-change and blocking events;
- automatic-healing rate and time to recovery;
- extraction-tier transitions;
- model tokens and cost by retailer and month.

The experimental price index is a demonstration artifact, not a statistical
validation claim. It covers the IPCA group *Alimentação e bebidas → alimentação
no domicílio* in São Paulo, using roughly four supermarkets and POF 2017–18
sub-item weights.

## 2. Scope and operating constraints

The initial retailers are Pão de Açúcar, Extra Mercado, Carrefour Mercado, and
St Marché. Sonda Delivery is the first replacement when stack diversity or
persistent blocking warrants a swap; Mambo Delivery and Shibata are the other
named backups. The minimum viable live panel is three retailers. The default
delivery location is CEP `01310-100`; a retailer-specific covered CEP may be
used and must be recorded.

The target catalog is 1,500–3,000 in-scope food products per retailer, with a
hard politeness cap near 2,000 product pages per retailer per day. Collection
runs off-peak with page concurrency 3–5, randomized delays, robots-aware
discovery, and bounded retries. The system collects no personal data.

Other IPCA groups, other regions, marketplaces, aggregators, dashboards,
hedonic adjustment, statistical index validation, and paid anti-blocking
services are outside the pilot. Proxies or other scraping-countermeasure
escalation require author approval. Raw retailer HTML, secrets, and backups are
never publication artifacts.

## 3. Architecture

The implementation is one TypeScript/Node monolith with a `precos` CLI and a
single SQLite database. Each pipeline stage is a CLI subcommand; cron or
systemd timers invoke those same commands. No queue, Redis, web service, or ORM
is introduced.

The repository is divided into focused modules:

- `src/strategies`: versioned strategy schemas, validation, and serialization;
- `src/discovery`: product-reference discovery executors;
- `src/collection`: product-field extraction executors;
- `src/explorer`: Codex SDK harness and disposable exploration sandbox;
- `src/healing`: run monitoring, failure classification, and regeneration;
- `src/normalize`: BRL parsing, units, canonicalization, and deduplication;
- `src/classify`: versioned batch classification into IPCA sub-items;
- `src/index`: daily relatives, aggregation, exports, and SIDRA comparison;
- `src/db`: hand-written schema and migrations;
- `src/ops`: structured logs, alerts, heartbeats, and budget enforcement;
- `src/cli.ts`: `discover`, `collect`, `heal`, `classify`, `index`, and `status`;
- `retailers`: retailer configuration and seed hints;
- `analysis`: reproducible thesis figures from exported CSV data;
- `ops`: setup, schedules, backup, health checks, and deployment notes.

The build follows the charter's collection-first milestones. Fixture-tested
deterministic executors precede temporary hand-authored live strategies. Live
collection begins before the exploration agent, healer, and analysis pipeline
are complete, and must not be interrupted by later feature work.

## 4. Strategy contracts

Discovery and extraction strategies are independently versioned tagged unions.
The generator must try the lowest robust tier first and may activate an
artifact only after trusted, out-of-sandbox validation.

Extraction tiers are:

1. `api`: allowlisted HTTP request templates and declarative JSON field paths;
2. `embedded-json`: HTTP HTML retrieval plus declarative extraction from
   JSON-LD, `__NEXT_DATA__`, or equivalent embedded state;
3. `dom`: Playwright navigation plus declarative CSS/XPath selectors and
   fallbacks;
4. `script`: a restricted instruction program over a closed `ctx` API.

Discovery tiers are `sitemap`, `api`, `dom-crawl`, and `script`. All executors
produce the same normalized result interfaces. Extraction attempts report
title, brand, regular price, promotional price, unit, availability, response
classification, and optional sampled raw-HTML material.

Tier-4 execution is not arbitrary JavaScript. It is an interpreted sequence of
typed operations such as `goto`, `click`, `fill`, `waitFor`, and `extract`.
Navigation and HTTP access are restricted to the configured retailer domains;
filesystem, process, dynamic evaluation, and general network access are absent.

## 5. Trusted validation and exploration

At generation or healing time, an exploration agent receives broad tooling
inside a disposable sandbox: shell, browser, HTTP tools, schema documentation,
sample URLs, the old strategy when applicable, and a validation CLI. Its prompt
requires tier-order probing and a final typed strategy JSON.

Only that JSON artifact may leave the sandbox. The trusted host parses the
schema and independently validates it against a sample of 30 product
references. A strategy activates only when at least 90% of samples have every
required field valid: title is non-empty, the effective price parses as a
positive BRL value, and any promotion is not greater than the regular price.
The loop ends on success or its configured event budget.

Exploration is never part of daily page collection. Model, prompt hash, token
usage, estimated USD cost, validation attempts, score, and resulting tier are
persisted for every generation event. The per-event guardrail is approximately
USD 5 per retailer; projected monthly model spending above USD 50 raises an
alert and pauses non-essential model work, never deterministic collection.

## 6. Persistence and observability

SQLite uses WAL mode, foreign keys, explicit transactions, and hand-written
migrations. Core tables are:

- `retailers`: identity, URL, CEP, platform hint, domains, active/degraded state;
- `strategies`: retailer, purpose, tier, version, JSON, provenance, validation,
  activation status, and timestamps;
- `products`: mutable current catalog identity and classification pointer;
- `observations`: append-only collection facts with strategy provenance;
- `runs`: append-only operational summary by retailer and pipeline stage;
- `run_failures`: categorized attempt evidence without aborting the run;
- `ipca_items`: cited sub-item definitions and weights;
- `classifications`: versioned rule/model decisions and confidence;
- `exploration_runs`: healing/generation attempts, tokens, cost, and outcome;
- `healing_events`: drift onset, attempts, recovery, tier transition, and timing;
- `heartbeats`: scheduled pipeline completion evidence.

Schema extensions beyond the charter's minimal table sketch are allowed when
they preserve its fields and make the required metrics queryable. Observations,
runs, strategy history, classifications, and healing evidence are append-only.
Products may update `last_seen` and current descriptive fields.

Approximately 20 randomly selected HTML responses per retailer per collection
day are gzip-compressed under a gitignored replay directory. Only their paths
and hashes are stored. They support drift comparison and deterministic
re-extraction; they are never published.

Logs are JSON Lines, secret-redacted, and rotated. `precos status` prints the
latest/yesterday summary per retailer and detects stale heartbeats. Alerts use
ntfy when `NTFY_TOPIC` is configured and otherwise append to a local alert log.

## 7. Daily data flow and failure behavior

For each active retailer, the daily pipeline:

1. executes the active extraction strategy over known in-scope products;
2. writes successful observations and categorized failures without aborting;
3. records one run summary whose attempted count equals successes plus failures;
4. distinguishes extraction drift from access blocking;
5. triggers regeneration for drift or bounded backoff and an alert for blocking;
6. normalizes and classifies new products incrementally;
7. records a completion heartbeat.

Discovery runs weekly and upserts canonical product references. Products no
longer found retain their history and stop receiving a newer `last_seen`.

The monitor marks a strategy drifted when a responding site yields less than
70% successful valid extractions. HTTP 403/429, CAPTCHA indicators, and
repeated network timeout classes are blocking rather than drift and must not
spend healing-model budget. Healing receives the previous strategy and failure
samples, then follows the same external-validation gate. Three consecutive
failed regeneration events mark the retailer degraded and alert the author.

Every page attempt has a bounded timeout. Persistent blocking skips the
remainder of that retailer's run after exponential backoff. Missing days and
degraded-retailer gaps remain explicit; the collector does not fabricate or
backfill them.

## 8. Normalization, classification, and index

BRL parsing handles thousands separators, decimal commas, currency text, and
minor presentation variants. Unit normalization retains the raw value and
derives quantity/base-unit metadata without changing observed prices.
Canonical retailer URLs prevent tracking parameters and fragments from
duplicating products.

New products are classified in batches near 50 using title, brand, and source
category plus the in-scope IPCA item list and few-shot examples. Results include
an item or `unclassified`, confidence, prompt/model version, usage, and cost.
Low-confidence results remain unclassified and are excluded from the index. A
stratified review export of roughly 200 products supports the thesis precision
check. Reclassification creates a new version instead of rewriting history.

The daily index calculation is deterministic:

1. choose promotional price when present, otherwise regular price;
2. form product relatives `p_t / p_(t-1)`;
3. carry a missing last price forward for at most seven days, then drop the
   product from the pair sample;
4. take the unweighted geometric mean within retailer and sub-item (Jevons);
5. take the arithmetic mean across retailers for each sub-item;
6. renormalize published IPCA/POF weights over covered sub-items;
7. aggregate sub-item relatives and chain them into the pilot daily level.

The item/weight loader commits its cited source CSV. A SIDRA client downloads
the São Paulo monthly `alimentação no domicílio` variation for overlapping
months. Exports include product coverage, sub-item series, aggregate series,
official comparison, run metrics, and healing metrics.

## 9. Operations and reproducibility

`ops/setup.sh` installs or verifies Node LTS, production/build dependencies,
Playwright Chromium dependencies, SQLite tooling, directories, the database,
and schedules. It is idempotent, never logs secrets, and permits a fresh clone
to reach a passing smoke test. Runtime timezone semantics are explicitly
`America/Sao_Paulo` even if the host timezone differs.

The installed schedule runs daily collection around 03:00 São Paulo time,
weekly discovery, a heartbeat check capable of noticing a missed daily run
within 24 hours, and a daily SQLite online backup. Backups rotate after 14 days.
Collection uses an exclusive process lock so overlapping scheduled runs fail
safely and alert rather than race.

The repo includes `.env.example`, documented configuration, a public-safe
`.gitignore`, an MIT license, and an honest English README describing an active
research pilot. `data` may publish the observation database and derived CSVs;
raw HTML, logs, alert files, locks, backups, browser profiles, and secrets stay
ignored. `ops/decisions.md` records material autonomous decisions.

## 10. Verification design

Tests are deliberately evidence-focused:

- unit tests for strategy schemas, URL/domain safety, BRL parsing, units,
  promotion invariants, failure classification, cost controls, and alerts;
- saved fixtures for discovery and extraction tiers 1–3;
- a mutated-layout fixture for each live retailer;
- database migration/invariant and CLI smoke tests;
- one hand-computed golden index chain including missing-price behavior;
- deterministic exploration-provider fixtures plus an opt-in live Codex SDK
  end-to-end test when credentials and budget are available;
- a staging sabotage that activates a broken strategy and proves the automatic
  healer installs a valid successor without human action;
- an operations smoke test for setup, backup rotation, lock behavior, stale
  heartbeat alerting, and analysis regeneration.

Live acceptance is measured from `runs`, not asserted by fixture tests. M2
requires two consecutive calendar days for at least two retailers at 90% or
better. M3 requires four retailers, or three plus a documented approved swap,
and at least 80% high-confidence classification. Time-based gates cannot be
counterfeited: if the live collection window has not elapsed, the implementation
reports the pending gate while leaving schedules running.

## 11. Milestone delivery

Each milestone receives its own acceptance audit and local commit:

- M0: rebuildable box setup, skeleton, schema, and working status command;
- M1: offline fixture-tested tiers 1–3 for both strategy purposes;
- M2: live hand-authored low-tier discovery/collection for at least two stores;
- M3: the full retailer panel, IPCA items, and incremental classification;
- M4: Codex SDK exploration with trusted external validation and cost logging;
- M5: automatic healing proven by mutated fixtures and staging sabotage;
- M6: index, SIDRA export, and reproducible thesis figures;
- M7: public-safe documentation, backups, alert/heartbeat drills, and a clean
  secret scan.

No later feature may stop collection once M2 is live. Where a real external
condition prevents immediate proof—two elapsed collection days, retailer
blocking, unavailable API credentials, or author-controlled publication—the
system must still be deployed safely, retain evidence, alert as specified, and
identify the exact unexpired acceptance gate.

## 12. Decision authority

Implementation may autonomously choose strategy tiers, selector/endpoint
details, bounded catalog scope, retries, schema additions that preserve data,
and a named retailer swap after three fully blocked days. Decisions are logged.

The affected subsystem pauses and alerts rather than guessing when work would
add a paid service, escalate scraping countermeasures, publish an unapproved
artifact, reduce the panel below three retailers, or change index methodology.

