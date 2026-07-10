import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { executeDom } from "../../src/collection/dom.js";
import { openDatabase } from "../../src/db/database.js";
import type { GenerationRequest, StrategyGenerator } from "../../src/explorer/provider.js";
import { monitorRun } from "../../src/healing/monitor.js";
import { runCollection } from "../../src/pipeline/collect.js";
import type { DomExtractionStrategy } from "../../src/strategies/schema.js";
import { startLocalHttpServer, type LocalHttpServer } from "../helpers/local-http-server.js";

const validStrategy = (domain: string): DomExtractionStrategy => ({
  schemaVersion: 1,
  purpose: "extraction",
  tier: "dom",
  allowedDomains: [domain],
  url: "{productUrl}",
  selectors: {
    title: [{ selector: ".product-title" }],
    brand: [{ selector: ".brand", attribute: "data-brand" }],
    price: [{ selector: ".regular-price" }],
    promoPrice: [{ selector: ".promotional-price" }],
    unit: [{ selector: ".unit" }],
    availability: [{ selector: ".stock", attribute: "data-available" }],
  },
});

const databases: Array<ReturnType<typeof openDatabase>> = [];
const temporaryRoots: string[] = [];
let browser: Browser;
let server: LocalHttpServer;

beforeAll(async () => {
  const html = await readFile(
    new URL("../fixtures/generic/dom-product.html", import.meta.url),
    "utf8",
  );
  server = await startLocalHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

describe("isolated staging sabotage", () => {
  it("heals a broken active selector through fake generation and trusted 30-sample validation", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const domain = new URL(server.origin).hostname;
    database.prepare(
      `INSERT INTO retailers
         (id, name, base_url, cep, domains_json, active)
       VALUES ('sabotage', 'Sabotage fixture', ?, '01310-100', ?, 1)`,
    ).run(server.origin, JSON.stringify([domain]));
    const broken = validStrategy(domain);
    broken.selectors.title = [{ selector: ".deliberately-broken-title" }];
    database.prepare(
      `INSERT INTO strategies
         (id, retailer_id, purpose, tier, version, strategy_json, provenance,
          validation_sample_size, validation_successes, validation_rate,
          active, validated_at, activated_at)
       VALUES ('sabotage-extraction-v1', 'sabotage', 'extraction', 3, 1, ?,
               'isolated sabotage fixture', 30, 30, 1, 1,
               '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')`,
    ).run(JSON.stringify(broken));
    const insertProduct = database.prepare(
      `INSERT INTO products
         (id, retailer_id, canonical_url, retailer_product_id, title,
          first_seen, last_seen)
       VALUES (?, 'sabotage', ?, ?, ?,
               '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')`,
    );
    for (let index = 0; index < 30; index += 1) {
      insertProduct.run(
        `product-${index}`,
        `${server.origin}/products/${index}`,
        String(index),
        `Fixture ${index}`,
      );
    }
    const rawHtmlRoot = await mkdtemp(join(tmpdir(), "healing-sabotage-"));
    temporaryRoots.push(rawHtmlRoot);
    const execute = (strategy: Parameters<typeof executeDom>[0], ref: Parameters<typeof executeDom>[1]) =>
      executeDom(strategy as DomExtractionStrategy, ref, { browser });

    const sabotagedRun = await runCollection("sabotage", {
      database,
      execute,
      concurrency: 4,
      rawHtmlRoot,
      now: () => new Date("2026-07-10T01:00:00.000Z"),
    });
    expect(sabotagedRun.successRate).toBeLessThan(0.7);
    expect(sabotagedRun.failed).toBe(30);

    let generationCalls = 0;
    const generator: StrategyGenerator = {
      async generate(_request: GenerationRequest) {
        generationCalls += 1;
        return {
          status: "candidate",
          model: "fixture-healer",
          strategy: validStrategy(domain),
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    };
    const decision = await monitorRun(sabotagedRun.id, {
      database,
      generator,
      execute,
      now: () => new Date("2026-07-10T01:05:00.000Z"),
    });

    expect(decision).toMatchObject({ health: "drift", action: "healed" });
    expect(generationCalls).toBe(1);
    expect(database.prepare(
      `SELECT version, active, retired_at
       FROM strategies WHERE retailer_id = 'sabotage' ORDER BY version`,
    ).all()).toEqual([
      { version: 1, active: 0, retired_at: "2026-07-10T01:05:00.000Z" },
      { version: 2, active: 1, retired_at: null },
    ]);
    expect(database.prepare(
      "SELECT status, successor_strategy_id, recovered_at FROM healing_events",
    ).get()).toMatchObject({
      status: "recovered",
      successor_strategy_id: expect.any(String),
      recovered_at: "2026-07-10T01:05:00.000Z",
    });

    const recoveredRun = await runCollection("sabotage", {
      database,
      execute,
      concurrency: 4,
      rawHtmlRoot,
      now: () => new Date("2026-07-11T01:00:00.000Z"),
    });
    expect(recoveredRun).toMatchObject({ ok: 30, failed: 0, successRate: 1 });
  }, 30_000);
});
