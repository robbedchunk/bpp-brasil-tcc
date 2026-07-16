# Operator runbook: activating a backup retailer from cold start

This runbook covers the complete path from "a primary retailer is degraded"
(for example Carrefour after repeated failed healings) to "the named backup
(Sonda) is active and collecting". It exists because the panel-replacement
policy and the activation command were documented, but the cold-start step in
between — a brand-new retailer has no catalog, while trusted validation
preselects its 30-reference challenge *from* the catalog
(`scripts/validate-strategies.ts`, `selectStrategyValidationChallenge` in
`src/strategies/validation-challenge.ts`) — previously had no operator tooling.
That hole is now closed by `precos catalog import` (`src/catalog/import.ts`,
migration `src/db/migrations/017_operator_catalog_seeds.sql`).

Honesty note: steps marked **MANUAL JUDGMENT** are decisions this tooling
deliberately does not automate. Steps marked **AUTOMATED** are deterministic
commands with fail-closed validation.

## What is automated vs. manual

| Step | Kind |
|---|---|
| 1. Confirm the swap policy gate (3 fully-blocked days) | MANUAL JUDGMENT |
| 2. Register the backup identity inactive | AUTOMATED (one command) |
| 3. Gather and curate seed references | MANUAL (no tooling fetches them) |
| 4. Import the seed catalog | AUTOMATED (`precos catalog import`) |
| 5. Flip config to active and pre-fill the validation block | MANUAL EDIT |
| 6. Trusted validation + activation | AUTOMATED (`strategies:validate`) |
| 7. Record the swap decision; M3 acceptance re-check | MANUAL + AUTOMATED |
| 8. First discovery/collection | AUTOMATED (scheduled or manual) |

## Step 1 — Policy gate (MANUAL JUDGMENT)

`ops/decisions.md` ("2026-07-10 — M2 retailer activation") records the policy:

> Sonda remains the named inactive first backup. […] It will not replace a
> primary without three consecutive days of recorded blocking.

"Recorded blocking" is evidence, not impression. Check, for each of the three
consecutive collection days:

- `runs.metadata_json` → `stoppedForBlocking: true` for the primary's collect
  runs (written by `src/pipeline/collect.ts` via `finalizeRun` in
  `src/db/repositories.ts`), e.g.
  `sqlite3 "file:data/precos.sqlite?mode=ro" "SELECT collection_day, status, json_extract(metadata_json,'$.stoppedForBlocking') FROM runs WHERE retailer_id='carrefour' AND stage='collect' ORDER BY started_at DESC LIMIT 6"`.
- `healing_events` for the primary (drift onset, failed attempts) and
  `retailer_state_events` (degraded/recovered boundaries, migration 012).
- `precos status --json` for the current degraded flag.

Automated degradation (failed healing) alone does **not** satisfy the gate.
If the gate holds, append a dated decision entry to `ops/decisions.md` naming
the evidence (run IDs, days). If it does not hold, stop here: healing and
successor-version recovery (`docs/strategy-validation.md`) are the correct
paths for a degraded-but-not-blocked primary.

## Step 2 — Register the backup identity, inactive (AUTOMATED)

```sh
npm run retailers:register -- --bootstrap-inactive --retailer sonda
```

**Warning — the `--retailer` filter is mandatory on the live host.** Without
it, the script loads *every* config in `retailers/` and bootstrap-inactive
mode deactivates and **retires** every currently active strategy of every
retailer (`registerRetailerConfigs`, `src/retailers/config.ts`). Retirement is
irreversible under the lifecycle triggers (migrations 002/014): recovery would
require version bumps and full revalidation of the whole panel. The
`--retailer` flag was added to this script for exactly this runbook.

This step is idempotent; on this host Sonda's retailer row already exists
inactive. It stages `sonda-discovery-v{n}` / `sonda-extraction-v{n}` strategy
rows inactive without trusting any config validation summary.

## Step 3 — Prepare seed references (MANUAL)

The operator must gather at least 30 (recommended: 100–300; hard cap: 3,000,
the `MAX_FOOD_CATALOG_PRODUCTS` catalog bound) in-scope product references.
**No tooling automates fetching them, deliberately.** Gathering must respect
the retailer's `robots.txt` and ordinary politeness: browse the official
public catalog surface manually, or use the operator's own carefully paced
fetches. `catalog import` itself performs **no network requests** and charges
**no request/reference admission ledgers** — that is verified by tests.

Source the references from the same official surface the discovery strategy
uses — for Sonda, the sitemap named in `retailers/sonda.json` `seedHints`
(`https://www.sondadelivery.com.br/sitemap.xml`).

Every reference must satisfy, or the whole import is refused:

- `canonicalUrl` on the retailer's registered domain allowlist
  (`retailers/sonda.json` `allowedDomains`, registered into
  `retailers.domains_json`); http(s) only, no credentials, subdomains allowed.
- In food-at-home scope under the fail-closed category rule
  (`src/catalog/scope.ts`, `food-at-home-category-v1`): the `sourceCategory`
  (authoritative when present) or the URL path must match an included term
  (mercearia, bebida, hortifruti, …) and no excluded term (limpeza, pet, …).
  A reference with neither signal fails closed — supply `sourceCategory`.
- No duplicate `canonicalUrl` within the file.

**Critical exactness requirement.** Discovery validation later requires the
challenge references to be *rediscovered live*: `scripts/validate-strategies.ts`
compares `canonicalUrl` + `externalId` + `sourceCategory` byte-for-byte
(`refKey`/`discoverySamples`). Seeds whose URL canonicalization, external ID,
or category spelling differ from what the discovery strategy actually yields
will honestly score as misses; below 27/30 the version is burned. Curate seeds
to match the strategy's own output shape.

Accepted formats (see `parseCatalogSeedFile` in `src/catalog/import.ts`):

JSON — a top-level array:

```json
[
  {
    "canonicalUrl": "https://www.sondadelivery.com.br/delivery/produto/cafe-torrado-500g/p",
    "externalId": "12345",
    "sourceCategory": "Mercearia",
    "title": "Café Torrado 500g"
  }
]
```

CSV — exact header, empty cells mean null:

```csv
canonical_url,external_id,source_category,title
https://www.sondadelivery.com.br/delivery/produto/cafe-torrado-500g/p,12345,Mercearia,
```

`externalId` and `title` are optional; `sourceCategory` is optional only when
the URL path itself carries an included food term. Keep the seed file under
ignored `var/operations/` — only its basename and SHA-256 enter the database
(private absolute paths are refused by a CHECK constraint).

## Step 4 — Import the seed catalog (AUTOMATED)

```sh
npm run precos -- catalog import --retailer sonda \
  --file var/operations/sonda-seeds.json --dry-run
npm run precos -- catalog import --retailer sonda \
  --file var/operations/sonda-seeds.json --json
```

The dry run validates everything and reports the plan without writing. The
real import is a single transaction that:

- refuses ACTIVE retailers and retailers with any active strategy, in code
  and again in a SQLite trigger (`catalog_seed_imports_cold_start_only`,
  migration 017) — an active retailer's catalog is discovery-owned evidence;
- refuses any domain/scope/duplicate rejection (all-or-nothing, with a
  per-reference rejection report), fewer than 30 references, or more than
  3,000;
- upserts `products` rows (`active=1`, `in_scope=1`) and writes append-only,
  immutable provenance: one `catalog_seed_imports` row (source label, file
  SHA-256, count, timestamp) plus one `catalog_seed_refs` row per reference
  (product link, scope reason/evidence/rule version). Seeded rows are thereby
  permanently distinguishable from discovered rows, whose provenance lives in
  `product_scope_decisions` bound to a running discovery run;
- is idempotent: re-importing the identical file is a no-op reporting
  `alreadyImported: true`; a corrected file gets its own import row and
  refreshes overlapping products without duplication;
- charges no admission ledger and touches no network.

Expected result: `"challengeReady": true` (at least 30 active in-scope
products). Verify independently if desired:

```sh
sqlite3 "file:data/precos.sqlite?mode=ro" \
  "SELECT COUNT(*) FROM products WHERE retailer_id='sonda' AND active=1 AND in_scope=1"
```

After this, the 30-reference challenge selection
(`selectStrategyValidationChallenge`) functions for the new retailer — this is
exactly the query the validator and the activation boundary
(`insertVerifiedStrategyValidationEvidence`, `src/db/database.ts`) run.

## Step 5 — Flip the config to active (MANUAL EDIT)

Edit `retailers/sonda.json`:

- `"active": true`.
- Confirm `strategyVersions`: failed validations permanently burn a version
  (`data/validation/attempts/`, `docs/strategy-validation.md`); bump to an
  unburned successor if needed.
- Pre-fill each `validation.{discovery,extraction}` block so the config schema
  parses: `externallyValidated: true`, `sampleSize: 30`, declared
  `successes`/`score` (score must equal successes/30), a `validatedAt`
  timestamp, the canonical
  `receiptPath` (`data/validation/sonda-<purpose>-v<version>.json`), and
  `receiptSha256: null`.

This pre-fill is an acknowledged awkwardness, not hidden magic: the schema
(`RetailerConfigSchema` in `src/retailers/config.ts`) requires active configs
to declare a 30-sample block, while the validator only accepts active configs.
`--update-config` overwrites the declared numbers with the actual signed
receipt aggregates before anything trusts them, and the rollout journal binds
to a normalized config in which these fields are zeroed
(`normalizedConfigCoreSha256`), so placeholder values never become evidence.
Activation itself never trusts config numbers — only the signed receipt
verified against the database challenge.

## Step 6 — Trusted validation and activation (AUTOMATED)

Preconditions: clean committed implementation tree; the Ed25519 signing key at
`var/operations/validation-attestation-private.pem` (`npm run
strategies:key:init` if this host has never signed); Playwright Chromium
available. Then:

```sh
npm run strategies:validate -- --retailer sonda --purpose all --update-config --activate
```

What happens (see `docs/strategy-validation.md` for the full contract): the
wrapper rebuilds the pinned validator bundle from the clean tree, runs in
`trusted-live-host` mode against the live site with ≥500 ms pacing, selects
the 30-reference challenge from the imported catalog *before* execution,
writes signed receipts to `data/validation/sonda-{purpose}-v{n}.json`, updates
the config aggregates atomically, and only then registers immutable
`strategy_validation_evidence` and activates. Direct SQL cannot activate: the
migration-014 triggers demand exact evidence rows that only the one-shot
in-process authorization (`src/db/database.ts`) can insert, and the evidence
must re-verify against the same 30-reference challenge.

- Pass gate: ≥27/30 per purpose (`activatable`, score ≥ 0.9).
- Failure: the receipt is preserved under `data/validation/attempts/`, the
  version is burned, and recovery goes through the successor tooling
  (`scripts/prepare-validation-successors.mjs` /
  `scripts/apply-validation-successors.mjs`).
- Commit the receipts and updated config together. Never commit the private
  key.

Note the ordering constraint: catalog import must precede activation — once
Sonda is active, `catalog import` refuses it by design, and the catalog
becomes discovery-owned.

## Step 7 — Panel accounting and M3 re-check (MANUAL + AUTOMATED)

- Record the executed swap in `ops/decisions.md` (which primary was replaced,
  the three blocked days' evidence, the receipt paths and scores).
- The degraded primary keeps its immutable history; do not delete or rewrite
  anything. Whether it stays active-but-degraded or is deactivated in its
  config is a documented panel decision, not a tooling default.
- Re-run acceptance: `npm run acceptance`. M3's retailer-panel expectation
  (≥4 active retailers, or a documented exception in `ops/decisions.md`) must
  hold after the swap; the sanitized report lands in `docs/acceptance-report.md`
  / `data/acceptance/`.

## Step 8 — First collection expectations

- **Frozen releases:** scheduled services run a frozen release, not this
  checkout. Until a new release is cut and installed
  (`scripts/create-release.mjs`, `docs/operations.md`), Sonda participates
  only in manual runs from the checkout:
  `npm run precos -- collect --retailer sonda --limit 50` and
  `npm run precos -- discover --retailer sonda`.
- Day 1 collection targets are the seeded products themselves
  (`listCollectionProducts` reads active in-scope rows). Seed titles are
  URL-slug placeholders; real titles arrive with the first successful
  extractions, after which classification (`precos classify`) becomes
  meaningful for those products.
- The first weekly discovery run (Sunday ~18:00 São Paulo in the scheduled
  release) expands and thereafter owns the catalog. Seed provenance rows
  remain forever; discovered rows accrue `product_scope_decisions` evidence.
- Watch `precos status --json`, run monitoring alerts, and the first
  `catalog_snapshots` row for Sonda (its first complete snapshot governs
  disappearance accounting).

## Known gaps (deliberately not papered over)

1. **Config pre-fill circularity.** Step 5's placeholder aggregates are
   required by the schema before real receipts exist. Fixing it properly means
   letting the validator accept an explicit `--activate-candidate` state or
   relaxing the schema for a declared "pending validation" state; neither
   exists today.
2. **Rediscovery exactness.** Seeds that do not byte-match the discovery
   strategy's live output (URL form, `externalId`, `sourceCategory`) burn
   validation attempts honestly. Expect an iteration or two; each failed
   attempt costs a strategy version.
3. **Seed gathering is manual by design.** There is no compliant automated
   fetcher; do not improvise one against robots/politeness policy.
4. **`docs/data-dictionary.md` does not yet document** `catalog_seed_imports`
   and `catalog_seed_refs` (out of scope for this change's file domain; the
   public dictionary should gain both rows).
5. **`--prepare-discovery-challenge`** in `scripts/validate-strategies.ts`
   describes staging inactive candidates and refreshing 120 bounded catalog
   references, but its implementation only asserts that a 30-reference
   challenge already exists. The cold-start path documented here does not rely
   on it.
6. **Degraded-primary bookkeeping** (deactivating Carrefour's config, panel
   size accounting in acceptance) remains a manual, documented decision; no
   command automates "swap out".
