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

An exploration worker may use broad tools only inside a disposable sandbox. Its
sole output is typed strategy JSON. The trusted host parses it and independently
validates exactly 30 unique product references; activation requires at least 27
fully valid results (score `>= 0.9`). Daily collection executes only stored
strategies and never invokes the model.

## Collection and healing

The São Paulo collection day is derived with `America/Sao_Paulo` semantics.
Runs are per retailer and page failures are categorized rather than aborting the
panel. Responding missing-field evidence below 70% success is drift. HTTP
403/429, CAPTCHA, domain denial, and dominant timeout/network evidence are
blocking and do not spend healing budget. Healing is queued for a separate
worker, reuses the trusted gate, and records every attempt and cost. Missing days
and degraded gaps are not backfilled.

## Classification

New products are mapped to one of the 84 in-scope São Paulo food-at-home IPCA
sub-items using title, brand, and source category. Evidence is versioned.
Confidence below 0.8 produces an explicit unclassified result; it remains in
coverage counts and is excluded from index aggregation. A stratified review
sample supports a separate thesis precision check.

## Experimental index

The fixed method version is `tcc-food-at-home-v1`:

1. use a positive promotion price when present, otherwise regular integer cents;
2. form same-product daily relatives without future look-ahead;
3. carry a missing product price for at most seven calendar days, and only when
   the retailer has a healthy target-day run;
4. take an unweighted geometric mean within retailer/sub-item (Jevons);
5. take an equal arithmetic mean across contributing retailers;
6. renormalize the exact POF weights over covered sub-items;
7. chain the covered-weight daily relative from 100, breaking the chain across
   missing whole-panel days.

No winsorization, quality adjustment, hedonic model, retailer sample-size
weighting, or additional imputation is used. Retailer min/max ranges are
descriptive sensitivity only and are not confidence intervals.

## Official comparison and limitations

The official series is IBGE SIDRA table 7060, variable 63, locality N7/3501,
classification 315/category 7171. It is monthly and is never interpolated to
daily frequency. The retailer CEP panel and official SNIPC São Paulo N7 area
have different geographic definitions. Open months and absent overlap remain
explicit. See `docs/sources.md` for provenance.
