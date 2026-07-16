# Methodology

## Research question and evidence

The thesis tests whether an LLM can generate and automatically repair online
price extraction strategies, reducing manual maintenance. Operational evidence
is therefore primary: daily retailer success rates, drift/blocking events,
automatic-healing outcomes and recovery time, strategy-tier transitions, and
model usage/cost. The experimental index demonstrates the resulting data; it is
not a statistically validated inflation measure.

## Strategy ladder

Discovery strategies use sitemap, API, DOM-crawl, then restricted-script tiers.
Extraction strategies use API, embedded JSON, declarative DOM, then a restricted
operation program. Lower tiers are preferred. HTTP/navigation is limited to
configured retailer domains. Tier 4 cannot execute arbitrary JavaScript or
access process/filesystem state.

For VTEX catalogs that require a delivery region, an API strategy may store the
public checkout-region identifier and sales channel as typed regional context.
The trusted executor derives the region selector only in memory for the bounded
retailer request; declarative strategies cannot store cookie or authorization
headers, and no session identifier enters evidence or publication artifacts.
When the catalog exposes a seller array, the strategy also binds the separately
validated catalog seller ID instead of relying on array order; checkout-region
and catalog-offer seller identities remain distinct when the retailer does so.

An exploration worker may use broad tools only inside a disposable sandbox. Its
sole output is typed strategy JSON. The trusted host parses it and independently
validates exactly 30 unique product references; activation requires at least 27
fully valid results (score `>= 0.9`). Daily collection executes only stored
strategies and never invokes the model.

Activation also requires an Ed25519-signed schema-v2 trusted-host receipt named
for the exact retailer, purpose, and strategy version. Before execution the live
validator fixes a 30-reference challenge from current in-scope database facts;
discovery cannot choose 30 convenient successes after seeing its output. It
executes sequentially at no less than 500 ms logical-request spacing and records
only bounded metadata, body hashes, normalized outcomes, returned identities,
regional seller facts, and per-sample duration. It never persists request
headers or raw bodies. Config registration and generated/healed activation use
the same verifier and immutable evidence row; an empty bootstrap may trust a
valid receipt itself, but never a human-readable aggregate alone.

## Catalog scope and refresh

Each active retailer declares broad food-at-home discovery capacity between
1,500 and 3,000 products. Category APIs are split into bounded food segments so
one narrow search term cannot define the basket; DOM discovery starts only from
declared food collections. Every reference receives an immutable, versioned
scope decision. Explicit source category is authoritative, exclusions are
checked first, and a category-retaining URL path is used only when the source
does not provide category data. Missing or ambiguous evidence fails closed.

Discovery references draw on their own 3,000-per-day admission ledger, while
every discovery and collection network request is charged pre-action, without
refund, against one shared 2,000-request ledger per retailer and São Paulo
day that bounds total daily traffic to a retailer. Because daily collection
(03:00) precedes the weekly Sunday discovery window (18:00) and can exhaust
that shared ledger, collection admissions are capped at 1,800 on Sundays: the
remaining 200 requests are spendable only by discovery (complete weekly
passes have used 58–108), and an unused reservation expires with the day. A
retailer product disappears only after the executor explicitly reports source
exhaustion, the iterator finishes naturally, and the run has no failed
references. Product/page/loop caps and errors create incomplete snapshots and
never deactivate unseen products. `last_seen` therefore moves only on
discovery and freezes at disappearance.

## Collection and healing

The São Paulo collection day is derived with `America/Sao_Paulo` semantics.
Runs are per retailer and page failures are categorized rather than aborting the
panel. Responding missing-field evidence below 70% success is drift. HTTP
403/429, CAPTCHA, domain denial, and dominant timeout/network evidence are
blocking and do not spend healing budget. Healing is queued for a separate
worker, reuses the trusted gate, and records every attempt and cost. Missing days
and degraded gaps are not backfilled. Degraded and recovered transitions are
append-only facts. Index eligibility uses the latest transition effective at or
before each collection run starts, so a later degradation cannot rewrite an
earlier retailer-day and recovery applies from its exact boundary onward.
Collection orders never-attempted products first and then the oldest observed or
attempted products, which gives deterministic coverage even when the known
catalog exceeds the 2,000-page daily ceiling.

For API, embedded-state, and DOM responses, collection selects a bounded random
daily sample before persistence. Up to 20 gzipped artifacts per retailer/day are
stored beneath a mode-0700 private root as mode-0600, content-addressed files;
observation/failure rows retain the paired relative path and SHA-256. Replay
storage failure cannot erase an otherwise valid price. The healer receives only
artifacts that pass bounded decompression and hash verification, and API or
embedded-state strategies can be re-extracted offline without network access.
Structured per-run JSONL logs are redacted, size/day rotated, and mode-0600;
raw bodies and product URLs are never logged.

## Classification

New products are mapped to one of the 84 in-scope São Paulo food-at-home IPCA
sub-items using title, brand, and source category. Evidence is versioned.
Confidence below 0.8 produces an explicit unclassified result; it remains in
coverage counts and is excluded from index aggregation. A stratified review
sample supports a separate thesis precision check. Classification eligibility
starts only after a successful observation supplies a descriptive title; a
numeric external ID, URL slug, or pending-title placeholder is never sent to the
model. Every published research snapshot pins one declared classification
version for all products; the automated publication frame is version 1 until a
reviewed implementation change advances it. A partial newer reclassification
therefore cannot create a hybrid historical series.

## Experimental index

The fixed method version is `tcc-food-at-home-v1`:

1. use a positive promotion price when present, otherwise regular integer cents;
2. form same-product daily relatives without future look-ahead;
3. exclude collection runs whose start falls in a degraded interval;
4. carry a missing product price, including an explicit unavailable result, for
   at most seven calendar days and only when the retailer has a healthy
   target-day run; exported relatives distinguish unavailable from an absent
   observation as the carry reason;
5. take an unweighted geometric mean within retailer/sub-item (Jevons);
6. take an equal arithmetic mean across contributing retailers;
7. renormalize the exact POF weights over covered sub-items;
8. chain the covered-weight daily relative from 100, breaking the chain across
   missing whole-panel days.

Snapshot manifests label steps 7–8 with the identifier
`covered_weight_laspeyres_chain` (the `parameters.acrossSubitems` field). The
identifier is retained verbatim because published snapshots embed it;
"laspeyres" in the name is a historical naming artifact, not a formula claim.
The computation is a fixed-expenditure-weight chained aggregate of the
Lowe/Young type: fixed POF expenditure weights, renormalized over the covered
weight, are applied to the daily sub-item relatives and the result is chained.
A strict Laspeyres index would instead require base-period quantity weights.
Using fixed POF expenditure weights matches IPCA practice, whose own weights
derive from the POF expenditure survey.

No winsorization, quality adjustment, hedonic model, retailer sample-size
weighting, or additional imputation is used. Retailer min/max ranges are
descriptive sensitivity only and are not confidence intervals.

## Official comparison and limitations

The official series is IBGE SIDRA table 7060, variable 63, locality N7/3501,
classification 315/category 7171. It is monthly and is never interpolated to
daily frequency. The retailer CEP panel and official SNIPC São Paulo N7 area
have different geographic definitions. Open months and absent overlap remain
explicit. See `docs/sources.md` for provenance.
