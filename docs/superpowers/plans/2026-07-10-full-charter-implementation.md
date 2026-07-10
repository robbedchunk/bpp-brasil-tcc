# Full TCC Extraction Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, deploy, and verify the complete M0–M7 self-healing São Paulo supermarket price-extraction pilot described by the approved charter.

**Architecture:** A single TypeScript/Node CLI executes typed, versioned discovery and extraction strategies against one SQLite database. Deterministic tiers remain on the daily hot path; Codex SDK exploration runs only for strategy generation/healing and its JSON output is independently validated before activation. Scheduled collection, operational evidence, classification, index production, and analysis all share explicit database contracts and reproducible CLI entry points.

**Tech Stack:** Node 24.18.0 Active LTS, npm 11.16.0, TypeScript ESM, Commander, Zod, better-sqlite3, Playwright Chromium, JSONPath Plus, Cheerio, OpenAI Node SDK, OpenAI Codex SDK, Vitest, Python 3 with pandas/matplotlib for thesis figures, SQLite, systemd user timers.

## Global Constraints

- Work in `/home/ubuntu-server/projects/tcc-ultra-super` on Ubuntu 26.04 x86_64; use Debian-compatible setup commands.
- Set `packageManager` to `npm@11.16.0` and `engines.node` to `>=24 <25`; systemd units use the discovered absolute Node 24/npm paths because they do not source an interactive version manager.
- Pin runtime packages to the researched 2026-07-10 set: `playwright@1.61.1`, `better-sqlite3@12.11.1`, `zod@4.4.3`, `commander@15.0.0`, `jsonpath-plus@10.4.0`, `cheerio@1.2.0`, `dotenv@17.4.2`, `fast-xml-parser@5.9.3`, `p-limit@7.3.0`, `csv-parse@7.0.1`, `decimal.js@10.6.0`, `robots-parser@3.0.1`, `@openai/codex-sdk@0.144.1`, and `openai@6.46.0`; dev pins are the mature `typescript@6.0.3` (rather than the two-day-old TypeScript 7 major), `vitest@4.1.10`, `@vitest/coverage-v8@4.1.10`, `tsx@4.23.0`, `execa@9.6.1`, `@types/node@24.13.3`, and `@types/better-sqlite3@7.6.13`. Lock all transitive dependencies.
- Use one SQLite database, a monolith CLI, hand-written SQL migrations, and no ORM, queue, Redis, service, or dashboard.
- Use `America/Sao_Paulo` for schedule and collection-day semantics.
- Never commit or log `OPENAI_API_KEY`, `NTFY_TOPIC`, raw HTML, browser profiles, backups, locks, or local alert/log files.
- Permit only retailer-domain HTTP/navigation; never use proxies, paid services, CAPTCHA bypass, or countermeasure escalation without author approval.
- Cap each retailer at 2,000 product attempts/day, page concurrency between 3 and 5, bounded retries/timeouts, and randomized polite delays.
- Respect robots.txt for discovery; page failures are categorized and counted but never abort the whole run.
- Require independent validation on 30 samples with score at least 0.9 before activating a strategy.
- Treat response-with-empty-fields as drift and 403/429/CAPTCHA/repeated timeout as blocking; blocking never triggers model healing.
- Pause non-essential LLM work and alert when projected monthly OpenAI spend exceeds USD 50; deterministic collection continues.
- Keep observations, runs, failures, classifications, strategy history, exploration attempts, and healing evidence append-only.
- Use promo price when present; carry missing product prices up to 7 days; Jevons within retailer/sub-item, equal retailer mean, then covered-weight-renormalized Laspeyres chaining.
- Keep code and README in English. Record material autonomous choices in `ops/decisions.md`.
- Use fixture-first TDD, a hand-computed index golden test, and live `runs` metrics for live acceptance.
- Commit each accepted task; do not rewrite or discard user changes.

## File and Responsibility Map

```text
package.json                         scripts, pinned runtime dependencies, precos bin
tsconfig.json                        strict NodeNext TypeScript configuration
vitest.config.ts                     offline-first test configuration
src/cli.ts                           command parsing and dependency wiring only
src/config.ts                        environment parsing and project paths
src/db/schema.sql                    complete idempotent base schema
src/db/migrations/*.sql              ordered forward-only schema changes
src/db/database.ts                   connection, migration, transaction helpers
src/db/repositories.ts               typed persistence operations
src/strategies/schema.ts             discovery/extraction Zod tagged unions
src/strategies/types.ts              inferred contracts and executor results
src/strategies/validate.ts           field scorer and 30-reference validation gate
src/normalize/brl.ts                 BRL parsing and formatting
src/normalize/unit.ts                quantity/base-unit normalization
src/normalize/url.ts                 domain checks and product URL canonicalization
src/discovery/executor.ts            uniform discovery dispatcher
src/discovery/sitemap.ts             robots-aware sitemap discovery
src/discovery/api.ts                 paginated JSON API discovery
src/discovery/dom-crawl.ts           bounded Playwright link crawl
src/collection/executor.ts           uniform extraction dispatcher
src/collection/api.ts                allowlisted HTTP/JSONPath extraction
src/collection/embedded-json.ts      JSON-LD/Next/data-layer extraction
src/collection/dom.ts                declarative Playwright selectors
src/collection/script.ts             closed-operation interpreter for tier 4
src/pipeline/discover.ts             product upsert and discovery run metrics
src/pipeline/collect.ts              concurrency, observations, sampling, run metrics
src/pipeline/daily.ts                daily orchestration and heartbeat
src/ops/logger.ts                    redacted JSONL logger and rotation
src/ops/alerts.ts                    ntfy/local alert sink
src/ops/lock.ts                      non-overlapping process lock
src/ops/heartbeat.ts                 completion and stale-run checks
src/ops/budget.ts                    usage accounting and monthly guardrail
src/healing/classify-failure.ts      drift-versus-blocking decision
src/healing/monitor.ts               threshold/event state machine
src/healing/heal.ts                  regeneration and activation workflow
src/explorer/provider.ts             injectable strategy-generator contract
src/explorer/codex-provider.ts       Codex SDK thread and sandbox package
src/explorer/prompt.ts               short tier-order exploration prompt
src/explorer/package.ts              disposable sandbox materialization
src/classify/provider.ts             injectable product classifier contract
src/classify/openai-provider.ts      Responses structured-output implementation
src/classify/classify.ts             incremental batching and persistence
src/index/relatives.ts               product pair construction/carry-forward
src/index/aggregate.ts               Jevons, retailer mean, weighted chain
src/index/sidra.ts                   official comparison API client
src/index/export.ts                  stable CSV exports
retailers/*.json                     public retailer configuration and strategies
data/reference/ipca_pof2017_2018_sp_food_at_home_weights.csv
                                     cited committed São Paulo weight input
scripts/load-ipca-items.ts           validation and one-time database loader
analysis/generate.py                 all thesis figures/tables in one command
ops/setup.sh                         idempotent host/bootstrap entry point
ops/install-systemd.sh               user units/timers installation
ops/precos-*.service                 one-shot user service definitions
ops/precos-*.timer                   São Paulo schedules
ops/backup.sh                        SQLite online backup and 14-day rotation
ops/check-heartbeat.sh               missed-run check and alert invocation
ops/smoke.sh                         fresh-install acceptance smoke test
ops/decisions.md                     dated autonomous decision log
tests/fixtures/**                    saved and mutated retailer fixtures
tests/**/*.test.ts                   offline unit/integration/CLI tests
```

---

### Task 1: M0 foundation, database, setup, and status CLI

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config.ts`, `src/db/schema.sql`, `src/db/database.ts`, `src/db/repositories.ts`, `src/cli.ts`
- Create: `tests/db/database.test.ts`, `tests/cli/status.test.ts`
- Create: `ops/setup.sh`, `ops/smoke.sh`, `ops/decisions.md`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig`
- Produces: `openDatabase(path: string): Database.Database`
- Produces: `migrate(db: Database.Database): void`
- Produces: `buildCli(deps?: CliDependencies): Command`
- Produces tables and constraints consumed by every later task.

- [ ] **Step 1: Write failing database and status tests**

```ts
it("creates every evidence table and enforces strategy activation uniqueness", () => {
  const db = openDatabase(":memory:");
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map((row: any) => row.name);
  expect(names).toEqual(expect.arrayContaining([
    "retailers", "strategies", "products", "observations", "runs",
    "run_failures", "ipca_items", "classifications", "exploration_runs",
    "healing_events", "heartbeats", "schema_migrations"
  ]));
});

it("prints a valid empty status report", async () => {
  const result = await runCli(["status", "--json"], { databasePath: tempDb });
  expect(JSON.parse(result.stdout)).toMatchObject({ retailers: [], staleHeartbeat: true });
  expect(result.exitCode).toBe(0);
});
```

- [ ] **Step 2: Run tests and confirm the missing-module failures**

Run: `npm test -- tests/db/database.test.ts tests/cli/status.test.ts`
Expected: FAIL because the project modules and schema do not exist.

- [ ] **Step 3: Implement the strict ESM scaffold and complete base schema**

The schema must include all charter columns plus explicit `run_failures`,
`exploration_runs`, `healing_events`, `heartbeats`, and `cost_ledger` tables;
foreign keys; non-negative monetary checks; `promo_price <= price`; unique
`(retailer_id, canonical_url)` products; unique strategy versions; and a partial
unique index allowing one active strategy per `(retailer_id, purpose)`.

```ts
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export interface AppConfig {
  databasePath: string;
  projectRoot: string;
  timezone: "America/Sao_Paulo";
  pageConcurrency: number;
  dailyPageCap: number;
  openaiApiKey?: string;
  ntfyTopic?: string;
}
```

- [ ] **Step 4: Implement `precos status` as a pure database report**

```ts
export interface StatusReport {
  generatedAt: string;
  staleHeartbeat: boolean;
  retailers: Array<{
    id: string; name: string; active: boolean; degraded: boolean;
    latestRun: null | { collectionDay: string; attempted: number; ok: number; failed: number; successRate: number };
  }>;
}
```

Human output is a compact table; `--json` emits only the JSON object. Status
never performs network work and returns nonzero only for database/config errors.

- [ ] **Step 5: Add idempotent setup and smoke scripts**

`ops/setup.sh` must select/verify Node `>=24 <25`, run `npm ci`, install Playwright
Chromium system dependencies only when missing, create runtime directories with
private permissions, initialize the database through the CLI, and optionally
install user timers with `INSTALL_TIMERS=1`. `ops/smoke.sh` runs typecheck,
offline tests, database init, and JSON status without revealing environment
values.

- [ ] **Step 6: Verify M0 and commit**

Run: `npm run typecheck && npm test && bash ops/setup.sh && bash ops/smoke.sh`
Expected: every command exits 0 and status returns a valid empty report.

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src tests ops
git commit -m "feat(m0): bootstrap database and status CLI"
```

### Task 2: M1 normalization and core result contracts

**Files:**
- Create: `src/normalize/brl.ts`, `src/normalize/unit.ts`, `src/normalize/url.ts`
- Create: `src/strategies/types.ts`
- Create: `tests/normalize/brl.test.ts`, `tests/normalize/unit.test.ts`, `tests/normalize/url.test.ts`

**Interfaces:**
- Produces: `parseBrl(input: unknown): number | null`
- Produces: `normalizeUnit(input: string | null): NormalizedUnit`
- Produces: `canonicalizeRetailerUrl(input: string, baseUrl: string, allowedDomains: string[]): string`
- Produces: `ExtractionResult`, `DiscoveryResult`, `FailureCategory`, and `ProductRef`.

- [ ] **Step 1: Write parsing, unit, and URL safety tests**

```ts
expect(parseBrl("R$ 1.299,90")).toBe(1299.90);
expect(parseBrl(" 12,5 ")).toBe(12.5);
expect(parseBrl("indisponível")).toBeNull();
expect(normalizeUnit("Pacote 500 g")).toMatchObject({ quantity: 500, unit: "g", baseQuantity: 0.5, baseUnit: "kg" });
expect(canonicalizeRetailerUrl("/produto/arroz?utm_source=x#top", "https://loja.test", ["loja.test"]))
  .toBe("https://loja.test/produto/arroz");
expect(() => canonicalizeRetailerUrl("https://evil.test/x", "https://loja.test", ["loja.test"])).toThrow(/domain/i);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- tests/normalize`
Expected: FAIL with missing normalization modules.

- [ ] **Step 3: Implement deterministic normalization and result types**

```ts
export type FailureCategory =
  | "http-403" | "http-429" | "captcha" | "timeout" | "network"
  | "parse" | "missing-fields" | "invalid-price" | "domain-denied" | "unknown";

export interface ExtractionResult {
  ok: boolean;
  fields?: { title: string; brand: string | null; price: number; promoPrice: number | null; unit: string | null; available: boolean };
  failure?: { category: FailureCategory; message: string; responded: boolean; statusCode?: number };
  html?: string;
}
```

BRL parsing rejects negative/zero/non-finite values and never guesses digit-only
thousands groupings ambiguously. URL canonicalization removes fragments and a
documented tracking-key allowlist while retaining product identity parameters.

- [ ] **Step 4: Run tests and commit**

Run: `npm run typecheck && npm test -- tests/normalize`
Expected: PASS.

```bash
git add src/normalize src/strategies/types.ts tests/normalize
git commit -m "feat(m1): add price unit and URL normalization"
```

### Task 3: M1 typed strategy schema and external validation gate

**Files:**
- Create: `src/strategies/schema.ts`, `src/strategies/validate.ts`
- Create: `tests/strategies/schema.test.ts`, `tests/strategies/validate.test.ts`

**Interfaces:**
- Consumes: `ExtractionResult`, `ProductRef`
- Produces: `DiscoveryStrategySchema`, `ExtractionStrategySchema`, `parseStrategy(json)`
- Produces: `validateExtractionStrategy(strategy, refs, execute, sampleSize = 30): ValidationReport`

- [ ] **Step 1: Write schema and scoring tests**

```ts
expect(ExtractionStrategySchema.parse({
  schemaVersion: 1, purpose: "extraction", tier: "api",
  request: { method: "GET", url: "{productUrl}", headers: {} },
  fields: { title: "$.name", price: "$.price", brand: "$.brand", promoPrice: "$.promo", unit: "$.unit", availability: "$.available" }
}).tier).toBe("api");

const report = await validateExtractionStrategy(strategy, thirtyRefs, fakeExecutorWith27Valid);
expect(report).toMatchObject({ attempted: 30, valid: 27, score: 0.9, activatable: true });
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/strategies`
Expected: FAIL with missing strategy modules.

- [ ] **Step 3: Implement discriminated unions for all eight tier contracts**

Every strategy contains `schemaVersion: 1`, `purpose`, `tier`, `allowedDomains`,
and tier-specific declarative fields. Request templates support only documented
placeholders. DOM selectors are ordered arrays. Script strategies contain only
typed operation objects; no JavaScript source field is accepted. Use `.strict()`
at every object boundary so unknown executable material is rejected.

```ts
export interface ValidationReport {
  attempted: number;
  valid: number;
  score: number;
  activatable: boolean;
  samples: Array<{ ref: ProductRef; valid: boolean; reason?: string }>;
}
```

Validation de-duplicates refs, requires exactly 30 when activation is requested,
checks every field invariant, and does not trust any score embedded in agent JSON.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test -- tests/strategies`
Expected: PASS including score boundary cases 0.899 and 0.9.

```bash
git add src/strategies tests/strategies
git commit -m "feat(m1): define and validate extraction strategies"
```

### Task 4: M1 HTTP API and embedded-JSON extraction executors

**Files:**
- Create: `src/collection/http.ts`, `src/collection/field-map.ts`, `src/collection/api.ts`, `src/collection/embedded-json.ts`, `src/collection/executor.ts`
- Create: `tests/fixtures/generic/api-product.json`, `tests/fixtures/generic/embedded-product.html`
- Create: `tests/collection/api.test.ts`, `tests/collection/embedded-json.test.ts`

**Interfaces:**
- Consumes: parsed `ExtractionStrategy`, `ProductRef`, normalization helpers
- Produces: `executeExtraction(strategy, ref, context): Promise<ExtractionResult>`
- Produces: injectable `FetchLike` and `ExtractionExecutionContext`.

- [ ] **Step 1: Save representative fixtures and write failing executor tests**

```ts
const result = await executeExtraction(apiStrategy, { canonicalUrl: "https://shop.test/p/1", externalId: "1" }, fixtureContext);
expect(result.fields).toEqual({ title: "Arroz Tipo 1", brand: "Marca", price: 12.99, promoPrice: 10.99, unit: "5 kg", available: true });

const embedded = await executeExtraction(jsonLdStrategy, productRef, htmlFixtureContext);
expect(embedded.ok).toBe(true);
expect(embedded.fields?.price).toBe(8.49);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- tests/collection/api.test.ts tests/collection/embedded-json.test.ts`
Expected: FAIL because executors are absent.

- [ ] **Step 3: Implement allowlisted HTTP, JSON paths, and embedded-state parsing**

Use `AbortSignal.timeout`, bounded response size, an identifying research user
agent, explicit redirect-domain validation, JSONPath Plus with value-only output,
and Cheerio only to locate script elements. Parse JSON-LD arrays/graphs,
`__NEXT_DATA__`, and configured script selectors. Convert raw mapped values
through one shared field mapper and return categorized failures rather than throw
for page-level errors.

- [ ] **Step 4: Verify offline fixtures and commit**

Run: `npm run typecheck && npm test -- tests/collection`
Expected: PASS without live network access.

```bash
git add src/collection tests/collection tests/fixtures/generic
git commit -m "feat(m1): execute API and embedded JSON strategies"
```

### Task 5: M1 Playwright DOM and restricted script executors

**Files:**
- Create: `src/collection/browser.ts`, `src/collection/dom.ts`, `src/collection/script.ts`
- Create: `tests/fixtures/generic/dom-product.html`, `tests/collection/dom.test.ts`, `tests/collection/script.test.ts`

**Interfaces:**
- Consumes: `ExtractionExecutionContext`, DOM/script strategy variants
- Produces: browser-backed `executeDom` and `executeRestrictedScript` returning `ExtractionResult`.

- [ ] **Step 1: Write browser fixture and security tests**

```ts
expect((await executeDom(domStrategy, ref, localFixtureContext)).fields?.price).toBe(19.9);
expect(() => ScriptStrategySchema.parse({ ...base, operations: [{ op: "evaluate", code: "process.env" }] })).toThrow();
await expect(executeRestrictedScript(crossDomainStrategy, ref, context)).resolves.toMatchObject({
  ok: false, failure: { category: "domain-denied" }
});
```

- [ ] **Step 2: Confirm tests fail before implementation**

Run: `npm test -- tests/collection/dom.test.ts tests/collection/script.test.ts`
Expected: FAIL with missing browser modules.

- [ ] **Step 3: Implement reusable browser context and closed operation interpreter**

DOM extraction tries selector fallbacks in order and reads text/attributes without
page evaluation. Script operations are limited to `goto`, `click`, `fill`,
`select`, `waitFor`, `scroll`, `http`, and `extract`; each has a timeout and total
operation limit. Route interception rejects nonessential third-party resources
and every navigation/redirect is rechecked against allowed domains. Contexts are
isolated per retailer and closed in `finally`.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test -- tests/collection`
Expected: PASS, including cross-domain and forbidden-operation tests.

```bash
git add src/collection tests/collection tests/fixtures/generic/dom-product.html
git commit -m "feat(m1): add declarative browser extraction tiers"
```

### Task 6: M1 discovery executors and robots policy

**Files:**
- Create: `src/discovery/robots.ts`, `src/discovery/sitemap.ts`, `src/discovery/api.ts`, `src/discovery/dom-crawl.ts`, `src/discovery/script.ts`, `src/discovery/executor.ts`
- Create: `tests/fixtures/generic/robots.txt`, `tests/fixtures/generic/sitemap.xml`, `tests/fixtures/generic/discovery-api.json`, `tests/fixtures/generic/category.html`
- Create: `tests/discovery/*.test.ts`

**Interfaces:**
- Consumes: discovery strategy variants and shared HTTP/browser contexts
- Produces: `executeDiscovery(strategy, context): AsyncGenerator<ProductRef>`
- Produces: `RobotsPolicy.canFetch(url): boolean` and discovered sitemap list.

- [ ] **Step 1: Write tier and robots tests**

```ts
expect(await collect(executeDiscovery(sitemapStrategy, ctx))).toEqual([
  { canonicalUrl: "https://shop.test/produto/1", externalId: null, sourceCategory: null }
]);
expect(robots.canFetch("https://shop.test/private/x")).toBe(false);
expect(await collect(executeDiscovery(apiPaginationStrategy, ctx))).toHaveLength(3);
```

- [ ] **Step 2: Confirm discovery tests fail**

Run: `npm test -- tests/discovery`
Expected: FAIL with missing discovery modules.

- [ ] **Step 3: Implement bounded, de-duplicated discovery**

Support sitemap indexes and gzip sitemaps; API page/offset/cursor termination;
DOM link selectors and pagination; script discovery through the same restricted
operations. Enforce robots for sitemap/DOM crawl, domain safety everywhere,
canonical URL deduplication, loop detection, page/product caps, and polite delay
in the caller rather than sleeping in parsers.

- [ ] **Step 4: Verify all M1 offline gates and commit**

Run: `npm run typecheck && npm test`
Expected: all fixture tests pass offline.

```bash
git add src/discovery tests/discovery tests/fixtures/generic
git commit -m "feat(m1): add tiered product discovery"
```

### Task 7: M2 pipeline orchestration, replay sampling, and run evidence

**Files:**
- Create: `src/pipeline/concurrency.ts`, `src/pipeline/discover.ts`, `src/pipeline/collect.ts`, `src/pipeline/daily.ts`
- Create: `src/collection/replay.ts`
- Modify: `src/db/repositories.ts`, `src/cli.ts`
- Create: `tests/pipeline/discover.test.ts`, `tests/pipeline/collect.test.ts`, `tests/pipeline/daily.test.ts`

**Interfaces:**
- Consumes: active strategies, repositories, executors, `AppConfig`
- Produces: `runDiscovery(retailerId, deps): Promise<RunSummary>`
- Produces: `runCollection(retailerId, deps): Promise<RunSummary>`
- Produces: `runDaily(deps): Promise<DailySummary>`.

- [ ] **Step 1: Write transactional pipeline tests**

```ts
expect(summary).toMatchObject({ attempted: 3, ok: 2, failed: 1, successRate: 2 / 3 });
expect(db.prepare("SELECT COUNT(*) n FROM observations").get()).toEqual({ n: 2 });
expect(db.prepare("SELECT COUNT(*) n FROM run_failures").get()).toEqual({ n: 1 });
expect(summary.attempted).toBe(summary.ok + summary.failed);
```

Test that one executor rejection becomes an `unknown` page failure, a 2,001st
product is not attempted, concurrency never exceeds 5, and exactly 20 of 100
eligible HTML bodies are selected with an injected seeded RNG.

- [ ] **Step 2: Verify pipeline tests fail**

Run: `npm test -- tests/pipeline`
Expected: FAIL with missing pipeline modules.

- [ ] **Step 3: Implement runs-first orchestration**

Create the run row before attempts; update counters and terminal status in
`finally`; store each success/failure transactionally; gzip sampled HTML with a
SHA-256 filename beneath `data/raw-html/YYYY-MM-DD/<retailer>/`; never place HTML
in SQLite. Upsert discovered products and retain history. CLI commands expose
`--retailer`, `--limit`, `--dry-run`, and `--json` without bypassing safety caps.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test -- tests/pipeline tests/cli`
Expected: PASS with deterministic counts and replay samples.

```bash
git add src/pipeline src/collection/replay.ts src/db/repositories.ts src/cli.ts tests/pipeline tests/cli
git commit -m "feat(m2): orchestrate discovery and collection runs"
```

### Task 8: M2 live retailer configs and initial deterministic strategies

**Files:**
- Create: `src/retailers/config.ts`, `scripts/register-retailers.ts`
- Create: `retailers/pao-de-acucar.json`, `retailers/extra-mercado.json`, `retailers/carrefour.json`, `retailers/st-marche.json`, `retailers/sonda.json`
- Create: `tests/retailers/config.test.ts`
- Create/update: `tests/fixtures/<retailer>/*` and one `mutated-product.*` per live retailer
- Modify: `ops/decisions.md`

**Interfaces:**
- Produces: `RetailerConfigSchema`, `loadRetailerConfigs(dir)` and idempotent registration.
- Config contains base URL, allowed domains, CEP, platform evidence, seed hints,
  discovery/extraction strategy, polite delay range, and fixture provenance.

- [ ] **Step 1: Write configuration/fixture contract tests**

```ts
for (const config of loadRetailerConfigs("retailers")) {
  expect(config.allowedDomains.length).toBeGreaterThan(0);
  expect(config.cep).toMatch(/^\d{5}-\d{3}$/);
  expect(config.discovery.purpose).toBe("discovery");
  expect(config.extraction.purpose).toBe("extraction");
  expect(await validateFixtureStrategy(config)).toMatchObject({ activatable: true });
}
```

- [ ] **Step 2: Capture minimal public fixtures and prove tests fail first**

Use no more than the requests needed to establish a strategy. Redact cookies,
session identifiers, delivery addresses, and response headers before saving.
Run: `npm test -- tests/retailers`
Expected: FAIL until every enabled config and fixture validates.

- [ ] **Step 3: Implement current low-tier retailer strategies**

Use the verified 2026-07-10 low-tier candidates and preserve their live evidence:

- Pão de Açúcar: GPA delivery lookup
  `https://api.vendas.gpa.digital/pa/delivery-v2/ecom/deliveryOptions?zipCode=01310100`
  selects store `61`, then GPA `POST /pa/search/search` supplies discovery and
  product/price fields. A browser-like identifying user agent avoids an Azion
  verification redirect on the storefront; do not attempt to bypass a challenge.
- Extra Mercado: the same official GPA flow beneath `/ex/`, using covered store
  `923` and `POST /ex/search/search`.
- Carrefour Mercado: use the public official account host
  `carrefourbrfood.vtexcommercestable.com.br` for VTEX catalog search (the
  storefront's canonical `/api/catalog_system` currently returns 503), pair it
  with the checkout region/seller result for CEP `01310100`, and retain the
  storefront's working sitemap shards as a discovery fallback.
- St Marché: use its working sitemap for product URLs and `window.__remixContext`
  embedded state for Shopify Hydrogen/Oxygen product/SKU/BRL availability fields;
  represent missing store selection honestly and promote to a restricted CEP/store
  script only if the low-tier 30-sample score remains below 0.9.

Keep Sonda configured as the named first backup (sitemap plus product JSON-LD),
with Mambo's working VTEX catalog as the next operational fallback. Do not swap a
primary without the charter's three-day blocking evidence. Do not fake a live
field or validation score.

- [ ] **Step 4: Register, externally validate, discover, and collect safely**

Run:

```bash
npm run retailers:register
npm run precos -- discover --limit 30 --json
npm run precos -- collect --limit 30 --json
npm run precos -- status --json
```

Expected: each reachable retailer has a persisted run; only independently
validated strategies become active; blocked stores are categorized and logged.

- [ ] **Step 5: Commit configs and the first live evidence database**

```bash
git add src/retailers scripts/register-retailers.ts retailers tests/retailers tests/fixtures ops/decisions.md data/*.sqlite
git commit -m "feat(m2): activate initial retailer strategies"
```

### Task 9: Operations, schedules, alerts, locks, and backups

**Files:**
- Create: `src/ops/logger.ts`, `src/ops/alerts.ts`, `src/ops/lock.ts`, `src/ops/heartbeat.ts`, `src/ops/budget.ts`
- Create: `tests/ops/logger.test.ts`, `tests/ops/alerts.test.ts`, `tests/ops/lock.test.ts`, `tests/ops/heartbeat.test.ts`, `tests/ops/budget.test.ts`
- Create: `ops/install-systemd.sh`, `ops/backup.sh`, `ops/check-heartbeat.sh`
- Create: `ops/precos-daily.service`, `ops/precos-daily.timer`, `ops/precos-weekly-discovery.service`, `ops/precos-weekly-discovery.timer`, `ops/precos-heartbeat.service`, `ops/precos-heartbeat.timer`, `ops/precos-backup.service`, `ops/precos-backup.timer`
- Modify: `src/pipeline/daily.ts`, `src/cli.ts`, `ops/setup.sh`

**Interfaces:**
- Produces: `AlertSink.send(event): Promise<void>`, `withProcessLock`,
  `recordHeartbeat`, `checkHeartbeat`, `BudgetGuard.decision`.

- [ ] **Step 1: Write alert, stale-heartbeat, lock, redaction, and budget tests**

```ts
expect(redact({ OPENAI_API_KEY: "secret", url: "ok" })).toEqual({ OPENAI_API_KEY: "[REDACTED]", url: "ok" });
expect(checkHeartbeat(now, lastSuccess25HoursAgo)).toMatchObject({ stale: true });
expect(budgetGuard.decide({ projectedMonthlyUsd: 50.01, essential: false })).toBe("pause");
expect(budgetGuard.decide({ projectedMonthlyUsd: 99, essential: true })).toBe("continue");
```

- [ ] **Step 2: Confirm ops tests fail**

Run: `npm test -- tests/ops`
Expected: FAIL with missing ops modules.

- [ ] **Step 3: Implement operational primitives and schedules**

Use an atomic exclusive lock file containing PID/start time; JSONL logs with
date/size rotation and recursive secret-key redaction; ntfy POST only for a
validated topic URL/name and local fallback otherwise; a successful end-of-run
heartbeat only after all active retailers reach a terminal state; and systemd
user units with `EnvironmentFile=-%h/.../.env`, `TZ=America/Sao_Paulo`, persistent
timers, and randomized delay. `ops/backup.sh` uses `sqlite3 "$DB" ".backup '$dst'"`,
verifies `PRAGMA integrity_check`, permissions `0600`, and deletes files older
than 14 days.

- [ ] **Step 4: Test the operational drills and commit**

Run:

```bash
npm run typecheck && npm test -- tests/ops
bash ops/backup.sh --self-test
bash ops/install-systemd.sh --dry-run
```

Expected: tests pass; self-test produces and validates a backup; dry-run shows
all four timers without installation.

```bash
git add src/ops src/pipeline/daily.ts src/cli.ts tests/ops ops
git commit -m "feat(ops): schedule and safeguard daily collection"
```

### Task 10: M3 IPCA reference loading and incremental classification

**Files:**
- Create: `data/reference/ipca_pof2017_2018_sp_food_at_home_weights.csv`, `data/reference/README.md`, `scripts/load-ipca-items.ts`
- Create: `src/classify/provider.ts`, `src/classify/openai-provider.ts`, `src/classify/prompt.ts`, `src/classify/classify.ts`
- Create: `tests/classify/classify.test.ts`, `tests/classify/openai-provider.test.ts`, `tests/fixtures/openai/classification-response.json`
- Modify: `src/cli.ts`, `src/ops/budget.ts`

**Interfaces:**
- Produces: `ProductClassifier.classify(inputs): Promise<ClassificationBatchResult>`
- Produces: `classifyNewProducts({ batchSize: 50, version, confidenceThreshold }, deps)`
- Produces CLI `classify` and `classify --review-sample 200`.

- [ ] **Step 1: Write loader, versioning, threshold, and batch tests**

```ts
expect(loadItems(csvFixture)).toContainEqual(expect.objectContaining({ group: "alimentação no domicílio", weight: expect.any(Number) }));
expect(fakeProvider.calls.map(c => c.length)).toEqual([50, 50, 20]);
expect(lowConfidenceProduct.ipcaItemId).toBeNull();
expect(db.prepare("SELECT COUNT(*) n FROM classifications WHERE product_id=?").get(id)).toEqual({ n: 2 });
```

- [ ] **Step 2: Verify classification tests fail**

Run: `npm test -- tests/classify`
Expected: FAIL with missing classifier modules.

- [ ] **Step 3: Commit a cited, validated IPCA item CSV and loader**

Use IBGE's final December-2019 POF structure archive
`https://ftp.ibge.gov.br/Precos_Indices_de_Precos_ao_Consumidor/IPCA/Atualizacao_das_Estruturas_POF2017-2018/Estruturas_para_divulgacao_dez19.zip`
(`Estrutura_IPCA.xlsx`, sheet `SP`) as the numeric source and BCB EE069 as the
method/cross-check citation. Select the 84 seven-digit sub-item codes beneath
`1100000` (`11.Alimentação no domicílio`); their São Paulo weights must sum to
`12.1181` percent before covered-item renormalization. Verify the archive SHA-256
`0ba845113682c96015a0e93daf4b10bc93aad82c2c1d6ea406282af958bf9104`
and workbook SHA-256
`2f6b759b3dfc4c38ebc791afc5c7e5e7a0b77b90c40f646246f4878a3dc4be4a`.

The CSV columns are
`pof_vintage,weight_reference_month,effective_from,sidra_area_level,sidra_area_code,area_name,snipc_subgroup_code,sidra_category_id,snipc_subitem_code,subitem_name,weight_pct_total_ipca,source_sheet,source_row,source_url,source_archive_sha256`.
The loader rejects duplicate codes, negative weights, non-food items, missing
citations, a row count other than 84, or a total outside `12.1181 ± 0.0001`, then
uses an idempotent transaction. Join sources on the seven-digit SNIPC code rather
than description (nine official names differ only in hyphen spacing), map the
weight into SQLite as percent of total São Paulo IPCA, and document that
aggregation renormalizes only covered rows. Record the covered-weight denominator
and fraction of `12.1181` in every index coverage export.

- [ ] **Step 4: Implement injectable classification and OpenAI structured output**

The provider receives only title, brand, source category, and allowed item list;
returns exactly one `{ productId, ipcaItemId|null, confidence, rationaleCode }`
per input via `openai@6.46.0` `responses.parse`, `zodTextFormat`, and a root strict
object whose properties are all required (use nullable, not optional, fields).
Default `OPENAI_CLASSIFICATION_MODEL` to `gpt-5.6-luna`, set `store: false`, and
host-validate exactly one result per input ID. Store model, prompt hash, usage,
and estimated cost, retry only transient API failures, and route budget-denied
batches to a pending count without touching collection. Use the asynchronous
Batch API only for initial backfill/reclassification, never as a blocker in the
daily pipeline.

- [ ] **Step 5: Verify, load items, and commit**

Run:

```bash
npm run typecheck && npm test -- tests/classify
npm run ipca:load
npm run precos -- classify --dry-run --json
```

Expected: offline tests pass, items load idempotently, and dry-run reports a
batch without making an API call.

```bash
git add data/reference scripts/load-ipca-items.ts src/classify src/cli.ts src/ops/budget.ts tests/classify tests/fixtures/openai
git commit -m "feat(m3): load IPCA items and classify products"
```

### Task 11: M4 Codex SDK exploration sandbox and trusted activation

**Files:**
- Create: `src/explorer/provider.ts`, `src/explorer/prompt.ts`, `src/explorer/package.ts`, `src/explorer/codex-provider.ts`, `src/explorer/explore.ts`
- Create: `src/explorer/sandbox/AGENTS.md`, `src/explorer/sandbox/strategy-schema.md`
- Create: `tests/explorer/package.test.ts`, `tests/explorer/explore.test.ts`, `tests/explorer/codex-provider.test.ts`
- Modify: `src/cli.ts`, `src/db/repositories.ts`

**Interfaces:**
- Produces: `StrategyGenerator.generate(request): Promise<GenerationResult>`
- Produces: `exploreRetailer(retailerId, purpose, deps): Promise<ExplorationOutcome>`
- Codex SDK provider is behind the interface; fixture provider drives offline tests.

- [ ] **Step 1: Write sandbox, untrusted-score, budget-loop, and activation tests**

```ts
expect(packageFiles).toEqual(expect.arrayContaining(["AGENTS.md", "strategy-schema.md", "samples.json", "validate-strategy"]));
expect(await exploreWithAgentClaimingOneButScoringPointEight()).toMatchObject({ activated: false, externalScore: 0.8 });
expect(await exploreWithSecondValidCandidate()).toMatchObject({ activated: true, attempts: 2, externalScore: 0.9 });
expect(activeStrategiesFor(retailerId, "extraction")).toHaveLength(1);
```

- [ ] **Step 2: Confirm explorer tests fail**

Run: `npm test -- tests/explorer`
Expected: FAIL with missing explorer modules.

- [ ] **Step 3: Implement disposable package and short tier-order prompt**

Package only schema docs, redacted configs, sample URLs/bodies, old strategy and
failure samples when healing, and an executable validator. The prompt states the
goal, tier order, domain/politeness constraints, exact output path, and stopping
budget. It does not contain secrets or ask the model to self-certify activation.

- [ ] **Step 4: Implement Codex SDK adapter and trusted loop**

Instantiate `@openai/codex-sdk@0.144.1` server-side with `apiKey` resolved from
`CODEX_API_KEY ?? OPENAI_API_KEY` so the charter-provided API key works while a
dedicated Codex key remains optional, plus an ephemeral
`CODEX_HOME`, start one thread rooted at the disposable sandbox, and use the SDK's
beta permission profile in `CodexOptions.config` to grant workspace writes plus
only the retailer domain allowlist. Do not combine that profile with legacy
`ThreadOptions.sandboxMode` or `networkAccessEnabled`. Pass a root object JSON
schema such as `{ strategy: Strategy }` through `TurnOptions.outputSchema`, parse
`result.finalResponse`, read only the expected JSON artifact, delete sandbox and
ephemeral Codex state in `finally`, then execute the host validator on 30 samples.
Persist every attempt and token/cost data available from SDK events; when exact
billing fields are unavailable, persist a documented estimate flag rather than
invent precision. Retire the previous active strategy and activate the successor
in one transaction only after score ≥0.9. Default the exploration model through
`OPENAI_EXPLORER_MODEL` to current frontier `gpt-5.6-sol`, reasoning effort
`medium`, while preserving the USD 5 event cap. The SDK reports tokens but not
USD; calculate estimates from a dated, tested price table and mark them estimated.

- [ ] **Step 5: Run offline and opt-in live acceptance, then commit**

Run:

```bash
npm run typecheck && npm test -- tests/explorer
LIVE_OPENAI=1 npm run test:live -- tests/explorer/codex-live.test.ts
```

Expected: offline suite always passes; live test runs only when credentials and
the explicit flag are present and yields a host-validated typed strategy.

```bash
git add src/explorer src/cli.ts src/db/repositories.ts tests/explorer
git commit -m "feat(m4): generate validated strategies with Codex"
```

### Task 12: M5 failure classification, drift monitor, and automatic healing

**Files:**
- Create: `src/healing/classify-failure.ts`, `src/healing/monitor.ts`, `src/healing/heal.ts`
- Create: `tests/healing/classify-failure.test.ts`, `tests/healing/monitor.test.ts`, `tests/healing/sabotage.test.ts`
- Modify: `src/pipeline/daily.ts`, `src/cli.ts`, `src/db/repositories.ts`

**Interfaces:**
- Produces: `classifyRunHealth(run, failures): "healthy" | "drift" | "blocking" | "mixed"`
- Produces: `monitorRun(runId, deps): Promise<MonitorDecision>`
- Produces: `healRetailer(retailerId, purpose, deps): Promise<HealingOutcome>`.

- [ ] **Step 1: Write threshold and no-wasted-model-call tests**

```ts
expect(classifyRunHealth(respondingRunAt0_69, missingFieldFailures)).toBe("drift");
expect(classifyRunHealth(forbiddenRun, http403Failures)).toBe("blocking");
expect(generator.calls).toBe(0); // after a blocking monitor decision
expect((await failedThreeTimes()).retailer.degraded).toBe(true);
```

- [ ] **Step 2: Write the staging sabotage test**

Activate a deliberately broken DOM selector against the original fixture, run
collection to create <0.7 success, inject a generator that returns the valid
fallback selector, run monitor/heal, then assert a higher strategy version is
active, the old one retired, the event recovered without human action, and the
next collection succeeds.

- [ ] **Step 3: Confirm healing tests fail**

Run: `npm test -- tests/healing`
Expected: FAIL with missing healing modules.

- [ ] **Step 4: Implement the monitor state machine and evidence**

Responded extraction failures dominate drift; access failures dominate blocking;
mixed evidence uses explicit ratios and errs toward blocking to avoid model spend.
Drift opens one idempotent healing event, carries old strategy/failing samples to
exploration, records recovery time/tier transition, and closes on valid activation.
Three consecutive regeneration failures alert and degrade only that retailer.

- [ ] **Step 5: Verify sabotage and commit**

Run: `npm run typecheck && npm test -- tests/healing tests/pipeline`
Expected: sabotage heals automatically; blocking never invokes the generator.

```bash
git add src/healing src/pipeline/daily.ts src/cli.ts src/db/repositories.ts tests/healing
git commit -m "feat(m5): detect drift and heal strategies automatically"
```

### Task 13: M6 index math, official SIDRA comparison, and CSV exports

**Files:**
- Create: `src/index/relatives.ts`, `src/index/aggregate.ts`, `src/index/sidra.ts`, `src/index/export.ts`
- Create: `tests/index/golden.test.ts`, `tests/index/missing.test.ts`, `tests/index/sidra.test.ts`, `tests/fixtures/sidra/table-7060.json`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `buildDailyIndex(db, options): IndexSeries`
- Produces: `fetchOfficialSeries(client, startMonth, endMonth): OfficialMonthlyPoint[]`
- Produces: `exportResearchData(db, outputDir): ExportManifest`.

- [ ] **Step 1: Write a hand-computed golden chain**

```ts
// Item A retailer relatives: sqrt(1.10 * 0.90) = sqrt(.99); second retailer = 1.02.
// Item B covered relative = 1.05. Covered weights A=60, B=40.
const expectedA = (Math.sqrt(0.99) + 1.02) / 2;
const expectedDaily = expectedA * 0.6 + 1.05 * 0.4;
expect(series[1].level).toBeCloseTo(100 * expectedDaily, 10);
```

Add cases proving promo selection, same-product consecutive pairing, one-to-seven
day carry-forward, drop on day eight, equal retailer weighting, coverage-weight
renormalization, and exclusion of unclassified/degraded observations.

- [ ] **Step 2: Confirm index tests fail**

Run: `npm test -- tests/index`
Expected: FAIL with missing index modules.

- [ ] **Step 3: Implement deterministic decimal-safe aggregation**

Sort by São Paulo collection day, collapse accidental same-day duplicates to the
latest successful observation, construct pair samples without survivor lookahead,
calculate geometric means through log sums, emit counts/coverage with every
relative, and chain from 100. Return `null` rather than silently substituting when
no valid covered items exist.

- [ ] **Step 4: Implement SIDRA client and stable public exports**

Use the verified table-7060 endpoint
`https://servicodados.ibge.gov.br/api/v3/agregados/7060/periodos/all/variaveis/63?localidades=N7%5B3501%5D&classificacao=315%5B7171%5D`:
variable `63` (monthly percentage), territorial level `N7[3501]` (São Paulo),
classification `315[7171]` (`11.Alimentação no domicílio`). Map only this target
and the requested overlap months; validate response metadata and numeric month
fields before accepting values.
Exports use UTF-8 CSV with ISO dates, decimal points, stable sorted columns, a
SHA-256 manifest, and exclude raw HTML/secret paths.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test -- tests/index && npm run precos -- index --export --json`
Expected: golden test passes and manifest lists aggregate, sub-item, coverage,
runs, failures, healing, costs, and official comparison CSV files.

```bash
git add src/index src/cli.ts tests/index tests/fixtures/sidra data/exports
git commit -m "feat(m6): calculate and export the experimental index"
```

### Task 14: M6 reproducible thesis figures and tables

**Files:**
- Create: `analysis/requirements.txt`, `analysis/generate.py`, `analysis/README.md`
- Create: `tests/analysis/generate.test.ts`, `tests/fixtures/analysis/*.csv`
- Modify: `package.json`

**Interfaces:**
- Consumes only committed/exported CSV schemas, never the live database directly.
- Produces: `success-rate.png`, `healing-events.csv`, `index-vs-ipca.png`, and `manifest.json`.

- [ ] **Step 1: Write a subprocess acceptance test**

```ts
const result = execaSync("python3", ["analysis/generate.py", "--input", fixtureDir, "--output", outDir]);
expect(result.exitCode).toBe(0);
for (const name of ["success-rate.png", "healing-events.csv", "index-vs-ipca.png", "manifest.json"]) {
  expect(statSync(join(outDir, name)).size).toBeGreaterThan(0);
}
```

- [ ] **Step 2: Verify the analysis test fails**

Run: `npm test -- tests/analysis/generate.test.ts`
Expected: FAIL because the generator is absent.

- [ ] **Step 3: Implement one-command deterministic analysis**

Use a noninteractive Matplotlib backend, fixed dimensions/colors/fonts, Portuguese
axis labels suitable for the thesis, explicit missing-data marks, success-rate
annotations at healing onset/recovery, and source/method footnotes. Write a
manifest of inputs, hashes, generation time, and output files. Fail clearly when
required columns are missing; tolerate an empty official overlap by generating a
labelled no-overlap comparison panel rather than inventing data.

- [ ] **Step 4: Verify and commit**

Run: `npm run analysis:test && npm run analysis`
Expected: fixture and current exports both regenerate all artifacts with one command.

```bash
git add analysis tests/analysis tests/fixtures/analysis package.json package-lock.json
git commit -m "feat(m6): generate reproducible thesis figures"
```

### Task 15: M7 publication readiness, ethics, and outsider documentation

**Files:**
- Create: `README.md`, `LICENSE`, `SECURITY.md`, `docs/methodology.md`, `docs/ethics-and-tos.md`, `docs/data-dictionary.md`, `docs/operations.md`, `docs/sources.md`
- Create: `scripts/audit-publication.ts`, `tests/publication/audit.test.ts`
- Modify: `.gitignore`, `.env.example`, `ops/setup.sh`, `ops/smoke.sh`, `ops/decisions.md`

**Interfaces:**
- Produces: `npm run audit:publication` with machine-readable and human output.

- [ ] **Step 1: Write publication audit tests**

```ts
expect(audit.trackedSecrets).toEqual([]);
expect(audit.trackedRawHtml).toEqual([]);
expect(audit.requiredDocsMissing).toEqual([]);
expect(audit.readmeClaims).toMatchObject({ researchPilot: true, activeDevelopment: true, noValidationClaim: true });
```

- [ ] **Step 2: Confirm audit test fails**

Run: `npm test -- tests/publication/audit.test.ts`
Expected: FAIL with missing documentation/auditor.

- [ ] **Step 3: Write honest public documentation and auditor**

README covers research status, defended claim, architecture, quick start, commands,
current live coverage, data limitations, out-of-scope list, citation, license, and
explicit raw-HTML exclusion. Ethics documents record throttling, robots stance,
no personal data, factual-price posture, ToS limitations, and no bypass methods.
The auditor scans tracked filenames and content patterns without printing matched
secret values and verifies every published CSV/database lacks raw HTML columns.

- [ ] **Step 4: Run fresh-clone and secret/publication checks**

Run:

```bash
npm run audit:publication
git grep -nE '(sk-[A-Za-z0-9_-]{20,}|OPENAI_API_KEY=.+)' -- . ':!package-lock.json'
bash ops/smoke.sh
```

Expected: audit passes, grep has no secret match, and smoke passes.

- [ ] **Step 5: Commit M7 documentation**

```bash
git add README.md LICENSE SECURITY.md docs scripts/audit-publication.ts tests/publication .gitignore .env.example ops
git commit -m "docs(m7): make the research pilot publication-ready"
```

### Task 16: Production activation and full charter acceptance audit

**Files:**
- Create: `ops/acceptance.ts`, `docs/acceptance-report.md`
- Create: `tests/ops/acceptance.test.ts`
- Modify: `ops/decisions.md`, `README.md`

**Interfaces:**
- Produces: `npm run acceptance -- --json` with per-milestone `pass|pending|fail`,
  evidence queries/paths, and no boolean claim unsupported by evidence.

- [ ] **Step 1: Write evidence-based acceptance tests**

```ts
expect(report.milestones.M1.status).toBe("pass");
expect(report.milestones.M2.status).toBe("pending");
expect(report.milestones.M2.reasons).toContain("requires two distinct successful collection days");
expect(report.publication.secretScanPassed).toBe(true);
```

- [ ] **Step 2: Implement the complete audit**

M0 checks clean setup/smoke; M1 offline suites and fixture inventory; M2 two
distinct calendar days for at least two retailers with ≥0.9 success; M3 live
retailer count and ≥0.8 high-confidence classification; M4 one valid agent result
per active retailer with cost evidence; M5 sabotage plus drift/blocking tests; M6
fresh exports/figures and golden math; M7 docs, backup, stale-heartbeat alert drill,
ignored-artifact checks, and secret scan. Time-gated requirements return `pending`,
never `pass`, until evidence actually exists.

- [ ] **Step 3: Install schedules and run non-destructive production drills**

Run:

```bash
bash ops/setup.sh
bash ops/install-systemd.sh
systemctl --user daemon-reload
systemctl --user enable --now precos-daily.timer precos-weekly-discovery.timer precos-heartbeat.timer precos-backup.timer
systemctl --user start precos-daily.service
systemctl --user start precos-backup.service
npm run precos -- status --json
```

Expected: timers are active, a collection terminal state and heartbeat exist,
backup integrity passes, and failures are categorized/alerted without secret output.

- [ ] **Step 4: Perform the safe missed-run alert drill**

Use the test clock/injected heartbeat record to simulate a heartbeat older than 24
hours and invoke the real configured alert sink; do not kill an actual collection
or create a real data hole. Record the alert receipt/local log hash and restore
normal state. This fulfills the charter's intent without sacrificing live data.

- [ ] **Step 5: Keep collection running until time-based gates mature**

After each scheduled day, rerun:

```bash
npm run acceptance -- --json
npm run precos -- status --json
```

Do not manufacture dates or backfill holes. Continue automated collection and
repair until M2's two-day evidence and every credential/site-dependent M3–M5 gate
are either passed or the charter-mandated alert/authority boundary is reached.

- [ ] **Step 6: Run final verification and commit the evidence report**

Run:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run audit:publication
npm run analysis
npm run acceptance
git status --short
```

Expected: all static/offline checks pass, generated analysis is current, acceptance
contains no `fail`, all elapsed/available gates are `pass`, and only explicitly
time-gated live evidence may remain `pending` while schedules stay active.

```bash
git add ops/acceptance.ts docs/acceptance-report.md tests/ops/acceptance.test.ts ops/decisions.md README.md data
git commit -m "test: record full charter acceptance evidence"
```
